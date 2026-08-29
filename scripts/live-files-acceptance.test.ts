import { chmodSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ProfileId } from "@/lib/profiles";
import { getAccessToken } from "@/server/auth/gate";
import { createAgentContext } from "@/server/agent/context";
import { createProductionChatModel, getConfiguredModelName, streamAgentEvents, type AgentRuntimeEvent } from "@/server/agent";
import { getDatabase } from "@/server/db/client";
import { FILE_STORAGE_BUCKET } from "@/server/files/repository";

const enabled = process.env.IRIS_RUN_LIVE_FILES_ACCEPTANCE === "1";
const PROFILE_ID: ProfileId = "profile-a";
const OTHER_PROFILE_ID: ProfileId = "profile-b";
const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_REQUESTS = 4;
const baseUrl = (process.env.IRIS_FILES_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

function writeReport(value: Record<string, unknown>) {
  const destination = process.env.IRIS_LIVE_FILES_ACCEPTANCE_RESULT_FILE;
  if (!destination) return;
  writeFileSync(destination, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  chmodSync(destination, 0o600);
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : "";
  if (message.includes("request_budget")) return "request_budget_exceeded";
  if (message.includes("abort") || message.includes("timeout")) return "turn_timeout";
  if (message.includes("openrouter") || message.includes("fetch")) return "provider_error";
  if (message.includes("upload_failed") || message.includes("files") || message.includes("storage")) return "local_data_error";
  if (message.includes("supabase") || message.includes("database")) return "local_data_error";
  return "acceptance_failed";
}

function toolNames(events: AgentRuntimeEvent[]) {
  return [...new Set(events.filter((event) => event.type === "tool_started" || event.type === "tool_finished").map((event) => event.toolName))].sort();
}

function textOutput(events: AgentRuntimeEvent[]) {
  return events.filter((event): event is Extract<AgentRuntimeEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text).join("");
}

function hasSuccessfulTool(events: AgentRuntimeEvent[], name: string, predicate: (output: unknown) => boolean) {
  return events.some((event) => event.type === "tool_finished" && event.toolName === name && event.ok && predicate(event.output));
}

async function jsonResponse(response: Response) {
  return await response.json() as Record<string, unknown>;
}

function cookieFor(profileId: ProfileId) {
  const pin = process.env.IRIS_APP_PIN;
  if (!pin) throw new Error("IRIS_APP_PIN is required.");
  return `iris-access=${getAccessToken(pin)}; iris-profile=${profileId}`;
}

async function collectTurn(input: Parameters<typeof streamAgentEvents>[0]) {
  const events: AgentRuntimeEvent[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  try {
    for await (const event of streamAgentEvents({ ...input, signal: controller.signal })) events.push(event);
    return { events, errorCode: undefined };
  } catch (error) {
    return { events, errorCode: errorCode(error) };
  } finally {
    clearTimeout(timeout);
  }
}

describe("guarded live files acceptance", () => {
  it.runIf(enabled)("uploads a real file and asks the production agent to use it", async () => {
    const tag = `accept-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const filename = `iris-live-${tag}.txt`;
    const marker = `Synthetic live file ${tag}`;
    const content = `${marker}\nProject: Lumen\nOwner: Priya\nNext action: send the checklist v2 draft to Priya before Friday at 17:00 UTC.\nDecision: ship checklist v2, not v1.`;
    const database = getDatabase();
    const storage = database.storage.from(FILE_STORAGE_BUCKET);
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    let fileId: string | null = null;
    let storagePath: string | null = null;
    let acceptanceReport: Record<string, unknown> | null = null;
    let cleanupPassed = true;

    try {
      writeReport({ status: "running", model: getConfiguredModelName(), requestCount: 0, observedToolNames: [], assertions: {} });
      const model = createProductionChatModel();
      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(OPENROUTER_CHAT_ENDPOINT)) {
          providerCalls += 1;
          if (providerCalls > MAX_REQUESTS) throw new Error("request_budget_exceeded");
        }
        return originalFetch(input, init);
      };

      const form = new FormData();
      form.set("file", new Blob([content], { type: "text/plain" }), filename);
      const uploadResponse = await fetch(`${baseUrl}/api/files`, { method: "POST", headers: { cookie: cookieFor(PROFILE_ID) }, body: form, signal: AbortSignal.timeout(30_000) });
      const uploadBody = await jsonResponse(uploadResponse);
      const uploaded = uploadBody.file as { fileId?: unknown; name?: unknown } | undefined;
      fileId = typeof uploaded?.fileId === "string" ? uploaded.fileId : null;
      if (uploadResponse.status !== 201 || !fileId || uploaded?.name !== filename) throw new Error(`upload_failed_http_${uploadResponse.status}_${String(uploadBody.error ?? "unknown")}`);

      const metadata = await database.from("files").select("id, profile_id, name, mime_type, size_bytes, storage_path").eq("id", fileId).eq("profile_id", PROFILE_ID).maybeSingle();
      if (metadata.error) throw metadata.error;
      storagePath = typeof metadata.data?.storage_path === "string" ? metadata.data.storage_path : null;
      const storedFile = await storage.download(storagePath ?? "missing");
      if (storedFile.error || !storedFile.data) throw storedFile.error ?? new Error("storage_download_failed");
      const storedContent = await storedFile.data.text();

      const profileBResponse = await fetch(`${baseUrl}/api/files/${fileId}`, { headers: { cookie: cookieFor(OTHER_PROFILE_ID) }, signal: AbortSignal.timeout(30_000) });
      const profileBBody = await jsonResponse(profileBResponse);

      const turn = await collectTurn({
        model,
        context: createAgentContext({ profileId: PROFILE_ID, profileLabel: "Profile A", threadId: crypto.randomUUID(), threadTitle: `Live file acceptance ${tag}`, browserTimezone: "UTC" }),
        messages: [{ role: "user", content: `Use file_search to find the uploaded file named ${filename}. Then use file_read on the returned file ID. After reading it, give me a concise two-item action plan using the exact owner, deadline, and decision from the file. Do not use any other tool and do not guess.` }],
        savedMemoryEnabled: false,
        referenceHistoryEnabled: false,
        accountabilityEnabled: false,
        webSearchEnabled: false,
        filesEnabled: true,
        forceToolName: "file_search",
      });
      const events = turn.events;
      const assertions = {
        uploadedViaApi: uploadResponse.status === 201 && fileId !== null,
        metadataPersistedForProfileA: Boolean(metadata.data && metadata.data.profile_id === PROFILE_ID && metadata.data.name === filename && metadata.data.size_bytes === Buffer.byteLength(content)),
        storageRoundTrip: storedContent === content,
        profileBCannotOpenProfileAFile: profileBResponse.status === 404 && profileBBody.error === "File not found.",
        agentFinishedWithoutRuntimeError: !turn.errorCode,
        agentUsedFileSearch: hasSuccessfulTool(events, "file_search", (output) => JSON.stringify(output).includes(fileId ?? "never")),
        agentReadExactContent: hasSuccessfulTool(events, "file_read", (output) => JSON.stringify(output).includes(marker)),
        agentDidUsefulWork: /Priya|Friday|checklist v2|17:00/i.test(textOutput(events)),
        requestBudget: providerCalls <= MAX_REQUESTS,
      };
      acceptanceReport = { status: Object.values(assertions).every(Boolean) ? "passed" : "failed", model: getConfiguredModelName(), requestCount: providerCalls, observedToolNames: toolNames(events), assertions };
      expect(Object.values(assertions).every(Boolean)).toBe(true);
    } catch (error) {
      acceptanceReport = { status: "failed", model: getConfiguredModelName(), requestCount: providerCalls, observedToolNames: [], errorCode: errorCode(error), assertions: {} };
      throw error;
    } finally {
      globalThis.fetch = originalFetch;
      if (fileId) {
        if (storagePath) await storage.remove([storagePath]);
        const deleted = await database.from("files").delete().eq("id", fileId).eq("profile_id", PROFILE_ID);
        cleanupPassed = !deleted.error;
      }
      const assertions = { ...((acceptanceReport?.assertions ?? {}) as Record<string, boolean>), cleanupReturnedToBaseline: cleanupPassed };
      const status = acceptanceReport?.status === "passed" && Object.keys(assertions).length > 0 && Object.values(assertions).every(Boolean) ? "passed" : "failed";
      writeReport({ ...(acceptanceReport ?? { model: getConfiguredModelName(), requestCount: providerCalls, observedToolNames: [] }), status, assertions, ...(status === "failed" && !acceptanceReport?.errorCode ? { errorCode: "assertion_failed" } : {}) });
      expect(cleanupPassed).toBe(true);
    }
  });
});
