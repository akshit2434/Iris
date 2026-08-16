import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProfileId } from "@/lib/profiles";
import { buildDynamicSystemPrompt, createAgentContext } from "@/server/agent/context";
import { createProductionChatModel, getConfiguredModelName, streamAgentEvents, type AgentRuntimeEvent } from "@/server/agent";
import { createAgentRun, createMessage, createThreadWithFirstMessage, getProfile, linkAgentRunMessages } from "@/server/db/queries";
import { getDatabase } from "@/server/db/client";
import { createMemoryArchiveService } from "@/server/memory/archive";
import { budgetCanonicalMemory } from "@/server/memory/context-budget";
import { createMemoryMutationService } from "@/server/memory/mutation";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { readMemoryChangeHint } from "@/server/memory/reconciliation";
import { memorySourceRows, validateOpenMessageAction } from "@/lib/memory-source";

const enabled = process.env.IRIS_RUN_LIVE_MEMORY_ACCEPTANCE === "1";
const PROFILE_ID: ProfileId = "profile-a";
const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MAX_REQUESTS = 6;

type Ledger = {
  profileId: ProfileId;
  threadIds: string[];
  messageIds: string[];
  runIds: string[];
  itemIds: string[];
  canonicalKeys: string[];
};

type Aggregate = {
  threads: number;
  messages: number;
  runs: number;
  events: number;
  contexts: number;
  items: number;
};

type TurnResult = {
  events: AgentRuntimeEvent[];
  errorCode?: string;
};

function writeReport(value: Record<string, unknown>) {
  const destination = process.env.IRIS_LIVE_ACCEPTANCE_RESULT_FILE;
  if (!destination) return;
  writeFileSync(destination, JSON.stringify(value), { encoding: "utf8", mode: 0o600 });
  chmodSync(destination, 0o600);
}

function errorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : "";
  if (message.includes("request_budget")) return "request_budget_exceeded";
  if (message.includes("abort") || message.includes("timeout") || message.includes("timed out")) return "turn_timeout";
  if (message.includes("openrouter") || message.includes("fetch")) return "provider_error";
  if (message.includes("profile") || message.includes("thread") || message.includes("message")) return "local_data_error";
  return "acceptance_failed";
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function toolNames(events: AgentRuntimeEvent[]) {
  return unique(events.filter((event) => event.type === "tool_started" || event.type === "tool_finished").map((event) => event.toolName)).sort();
}

function textOutput(events: AgentRuntimeEvent[]) {
  return events.filter((event): event is Extract<AgentRuntimeEvent, { type: "text_delta" }> => event.type === "text_delta").map((event) => event.text).join("");
}

function hasFinishedTool(events: AgentRuntimeEvent[], name: string, predicate: (output: unknown) => boolean) {
  return events.some((event) => event.type === "tool_finished" && event.toolName === name && event.ok && predicate(event.output));
}

async function countRows(table: "threads" | "messages" | "agent_runs" | "agent_events" | "thread_context" | "memory_items") {
  const column = table === "thread_context" ? "thread_id" : "id";
  const { count, error } = await getDatabase().from(table).select(column, { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

async function aggregate(): Promise<Aggregate> {
  const [threads, messages, runs, events, contexts, items] = await Promise.all([
    countRows("threads"),
    countRows("messages"),
    countRows("agent_runs"),
    countRows("agent_events"),
    countRows("thread_context"),
    countRows("memory_items"),
  ]);
  return { threads, messages, runs, events, contexts, items };
}

function sameAggregate(left: Aggregate, right: Aggregate) {
  return (Object.keys(left) as Array<keyof Aggregate>).every((key) => left[key] === right[key]);
}

function persistLedger(path: string, ledger: Ledger) {
  writeFileSync(path, JSON.stringify(ledger), { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

async function insertHistoricalThread(ledger: Ledger, threadId: string, messageId: string, createdAt: string, content: string, title: string) {
  const database = getDatabase();
  const { error: threadError } = await database.from("threads").insert({
    id: threadId,
    profile_id: PROFILE_ID,
    title,
    created_at: createdAt,
    updated_at: createdAt,
  });
  if (threadError) throw threadError;
  ledger.threadIds.push(threadId);
  ledger.messageIds.push(messageId);
  const { error: messageError } = await database.from("messages").insert({
    id: messageId,
    thread_id: threadId,
    profile_id: PROFILE_ID,
    role: "user",
    content,
    created_at: createdAt,
  });
  if (messageError) throw messageError;
}

async function createFreshTurn(ledger: Ledger, tag: string, content: string) {
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const assistantMessageId = crypto.randomUUID();
  const result = await createThreadWithFirstMessage({
    profileId: PROFILE_ID,
    threadId,
    userMessageId: messageId,
    runId,
    assistantMessageId,
    requestId: `acceptance-${tag}-${crypto.randomUUID()}`,
    content,
    model: getConfiguredModelName(),
  });
  ledger.threadIds.push(result.threadId);
  ledger.messageIds.push(result.userMessageId);
  ledger.runIds.push(result.runId);
  return { threadId: result.threadId, messageId: result.userMessageId, runId: result.runId };
}

async function createExistingTurn(ledger: Ledger, threadId: string, tag: string, content: string) {
  const messageId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const run = await createAgentRun({
    id: runId,
    profileId: PROFILE_ID,
    threadId,
    requestId: `acceptance-${tag}-${crypto.randomUUID()}`,
    model: getConfiguredModelName(),
  });
  await createMessage({ id: messageId, profileId: PROFILE_ID, threadId, role: "user", content, agentRunId: run.id });
  await linkAgentRunMessages(PROFILE_ID, threadId, run.id, { userMessageId: messageId });
  ledger.messageIds.push(messageId);
  ledger.runIds.push(run.id);
  return { messageId, runId: run.id };
}

const TURN_DEADLINE_MS = 45_000;

async function collectTurn(input: Parameters<typeof streamAgentEvents>[0]): Promise<TurnResult> {
  const events: AgentRuntimeEvent[] = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TURN_DEADLINE_MS);
  try {
    for await (const event of streamAgentEvents({ ...input, signal: controller.signal })) events.push(event);
    return { events };
  } catch (error) {
    return { events, errorCode: errorCode(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function requireHealthyTurn(result: TurnResult) {
  if (result.errorCode) throw new Error(result.errorCode);
}

async function cleanup(ledgerPath: string, ledger: Ledger) {
  const database = getDatabase();
  const itemIds = unique(ledger.itemIds);
  for (const itemId of itemIds) {
    await database.from("memory_item_sources").delete().eq("profile_id", ledger.profileId).eq("item_id", itemId);
    await database.from("memory_item_revisions").delete().eq("profile_id", ledger.profileId).eq("item_id", itemId);
    await database.from("memory_suppressions").delete().eq("profile_id", ledger.profileId).eq("item_id", itemId);
    await database.from("memory_items").delete().eq("profile_id", ledger.profileId).eq("id", itemId);
  }
  const threadIds = unique(ledger.threadIds);
  if (threadIds.length > 0) {
    const { error } = await database.from("threads").delete().eq("profile_id", ledger.profileId).in("id", threadIds);
    if (error) throw error;
  }
  rmSync(ledgerPath, { force: true });
  rmSync(join(ledgerPath, ".."), { force: true, recursive: true });
}

describe("guarded live memory acceptance", () => {
  it.runIf(enabled)("uses real production tools against disposable local synthetic state", async () => {
    const ledgerDirectory = mkdtempSync(join(tmpdir(), "iris-memory-acceptance-"));
    const ledgerPath = join(ledgerDirectory, "ledger.json");
    const tag = `accept-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const canonicalKey = `acceptance.${tag}`;
    const ledger: Ledger = { profileId: PROFILE_ID, threadIds: [], messageIds: [], runIds: [], itemIds: [], canonicalKeys: [canonicalKey] };
    persistLedger(ledgerPath, ledger);
    const database = getDatabase();
    const store = createSupabaseMemoryStore(database);
    const memoryMutation = createMemoryMutationService(store);
    const memoryArchive = createMemoryArchiveService(store);
    const oldMessageIds: string[] = [];
    const observedEvents: AgentRuntimeEvent[] = [];
    let acceptanceReport: Record<string, unknown> | null = null;
    let failureCode: string | undefined;
    let providerCalls = 0;
    const originalFetch = globalThis.fetch;
    let baseline: Aggregate | null = null;
    let profile: Awaited<ReturnType<typeof getProfile>> = null;

    try {
      writeReport({ status: "running", model: getConfiguredModelName(), requestCount: 0, observedToolNames: [], assertions: {} });
      baseline = await aggregate();
      profile = await getProfile(PROFILE_ID);
      if (!profile) throw new Error("profile_missing");
      // Construct the real provider before creating any synthetic rows. A
      // local configuration failure must leave the database untouched.
      const model = createProductionChatModel();
      const baselineRevision = await store.getCurrentRevision(PROFILE_ID);
      const baselineItemIds = new Set((await store.listItems(PROFILE_ID, { includeArchived: true })).map((item) => item.id));
      const oldThreads = [
        { threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), at: "2026-08-13T10:00:00.000Z", text: `${tag}: Project Ember early launch plan was 2026-08-01.` },
        { threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), at: "2026-07-05T10:00:00.000Z", text: `${tag}: Project Ember launch decision was 2026-08-15.` },
        { threadId: crypto.randomUUID(), messageId: crypto.randomUUID(), at: "2026-03-16T10:00:00.000Z", text: `${tag}: Project Ember was a fictional planning exercise with an early target of 2026-07-01.` },
      ];
      for (const oldThread of oldThreads) {
        await insertHistoricalThread(ledger, oldThread.threadId, oldThread.messageId, oldThread.at, oldThread.text, `Synthetic ${tag}`);
        oldMessageIds.push(oldThread.messageId);
        await database.from("thread_context").update({ memory_revision_seen: baselineRevision }).eq("profile_id", PROFILE_ID).eq("thread_id", oldThread.threadId);
      }

      globalThis.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(OPENROUTER_CHAT_ENDPOINT)) {
          providerCalls += 1;
          if (providerCalls > MAX_REQUESTS) throw new Error("request_budget_exceeded");
        }
        return originalFetch(input, init);
      };

      const chatA = await createFreshTurn(ledger, tag, `Synthetic ${tag}: remember a durable corrected fact about the fictional Project Ember launch date.`);
      const chatAContext = createAgentContext({ profileId: PROFILE_ID, profileLabel: profile.displayName, threadId: chatA.threadId, threadTitle: `Synthetic ${tag} A`, browserTimezone: "UTC", currentUserMessageId: chatA.messageId, agentRunId: chatA.runId, now: new Date("2026-08-16T00:00:00.000Z") });
      const chatAResult = await collectTurn({
        model,
        context: chatAContext,
        memoryMutation,
        returnDirectTools: ["memory_patch"],
        messages: [{ role: "user", content: `I explicitly want you to remember one durable synthetic fact now. Use memory_patch immediately with canonicalKey ${canonicalKey}, mutationKind create, expectedItemRevision null, and plain content saying the fictional Project Ember launch date is 2026-09-30 and supersedes earlier plans. Make the tool call your only action.` }],
      });
      observedEvents.push(...chatAResult.events);
      requireHealthyTurn(chatAResult);

      const itemAfterPatch = await store.getItem(PROFILE_ID, canonicalKey, { includeArchived: true });
      if (itemAfterPatch) ledger.itemIds.push(itemAfterPatch.id);
      for (const item of await store.listItems(PROFILE_ID, { includeArchived: true })) {
        if (!baselineItemIds.has(item.id) && item.content.includes(tag)) ledger.itemIds.push(item.id);
      }
      const currentItems = await store.listItems(PROFILE_ID);
      const canonicalMemory = budgetCanonicalMemory(currentItems, await store.getCurrentRevision(PROFILE_ID), { profileId: PROFILE_ID });

      const chatB = await createFreshTurn(ledger, tag, `Synthetic ${tag}: answer a short question about the current fictional Project Ember launch date.`);
      const chatBResult = await collectTurn({
        model,
        context: createAgentContext({ profileId: PROFILE_ID, profileLabel: profile.displayName, threadId: chatB.threadId, threadTitle: `Synthetic ${tag} B`, browserTimezone: "UTC", currentUserMessageId: chatB.messageId, agentRunId: chatB.runId, canonicalMemory, now: new Date("2026-08-16T00:01:00.000Z") }),
        messages: [{ role: "user", content: "What is the current fictional Project Ember launch date? Answer briefly from the canonical context and do not call a tool." }],
      });
      observedEvents.push(...chatBResult.events);
      requireHealthyTurn(chatBResult);

      const chatC = await createFreshTurn(ledger, tag, `Synthetic ${tag}: find the exact source of a prior decision.`);
      const chatCResult = await collectTurn({
        model,
        context: createAgentContext({ profileId: PROFILE_ID, profileLabel: profile.displayName, threadId: chatC.threadId, threadTitle: `Synthetic ${tag} C`, browserTimezone: "UTC", currentUserMessageId: chatC.messageId, agentRunId: chatC.runId, canonicalMemory, now: new Date("2026-08-16T00:02:00.000Z") }),
        memoryRetrieval: { searchMessages: (input) => store.searchMessages(input), readMessages: (profileId, messageId, windowSize) => store.readMessageContext(profileId, messageId, windowSize), listMemory: (profileId) => store.listItems(profileId), currentRevision: (profileId) => store.getCurrentRevision(profileId), readMemory: (profileId, key) => store.getItem(profileId, key), searchMemory: (profileId, query, limit) => store.searchItems(profileId, query, limit) },
        returnDirectTools: ["search_messages", "read_messages"],
        messages: [{ role: "user", content: "Where did I decide that? Search prior chats for the exact source of the fictional Project Ember launch decision and return a validated internal open source action. Do not guess and do not use an external URL." }],
      });
      observedEvents.push(...chatCResult.events);
      requireHealthyTurn(chatCResult);

      const oldTurn = await createExistingTurn(ledger, oldThreads[0].threadId, tag, `Synthetic ${tag}: what is the current fictional Project Ember launch date? Use the latest memory correction, not stale history.`);
      const throughRevision = await store.getCurrentRevision(PROFILE_ID);
      const changeHint = await readMemoryChangeHint({ store, profileId: PROFILE_ID, afterRevision: baselineRevision, throughRevision });
      const oldCanonical = budgetCanonicalMemory(await store.listItems(PROFILE_ID), throughRevision, { profileId: PROFILE_ID });
      const oldContext = createAgentContext({ profileId: PROFILE_ID, profileLabel: profile.displayName, threadId: oldThreads[0].threadId, threadTitle: `Synthetic ${tag} old`, browserTimezone: "UTC", currentUserMessageId: oldTurn.messageId, agentRunId: oldTurn.runId, canonicalMemory: oldCanonical, memoryChangeHint: changeHint, now: new Date("2026-08-16T00:03:00.000Z") });
      const oldResult = await collectTurn({ model, context: oldContext, messages: [{ role: "user", content: "What is the current fictional Project Ember launch date? Use the latest correction." }] });
      observedEvents.push(...oldResult.events);
      requireHealthyTurn(oldResult);

      const patchFinished = chatAResult.events.find((event): event is Extract<AgentRuntimeEvent, { type: "tool_finished" }> => event.type === "tool_finished" && event.toolName === "memory_patch");
      const sourceRows = chatCResult.events.flatMap((event) => event.type === "tool_finished" && (event.toolName === "search_messages" || event.toolName === "read_messages") ? memorySourceRows(event.toolName, event.output, PROFILE_ID) : []);
      const sourceRow = sourceRows.find((row) => oldMessageIds.includes(row.action.messageId));
      const archiveRevision = itemAfterPatch?.itemRevision ?? 0;
      const archiveResult = itemAfterPatch && archiveRevision > 0
        ? await memoryArchive.archive({ profileId: PROFILE_ID, threadId: chatC.threadId, currentUserMessageId: chatC.messageId, agentRunId: chatC.runId, toolCallId: `acceptance-archive-${tag}`, canonicalKey, expectedItemRevision: archiveRevision, reason: "Synthetic acceptance cleanup." })
        : { status: "not_found" as const, canonicalKey, reason: "Synthetic memory item was not created." };
      const activeAfterArchive = await store.getItem(PROFILE_ID, canonicalKey);
      const rawSourceStillPresent = Boolean(await store.readMessageContext(PROFILE_ID, oldMessageIds[0], 1));
      const assertions = {
        requestBudget: providerCalls <= MAX_REQUESTS,
        chatAPatchStarted: chatAResult.events.some((event) => event.type === "tool_started" && event.toolName === "memory_patch"),
        chatAPatchFinished: Boolean(patchFinished && patchFinished.ok && patchFinished.output && typeof patchFinished.output === "object" && (patchFinished.output as Record<string, unknown>).status === "applied"),
        canonicalMutationApplied: Boolean(itemAfterPatch && itemAfterPatch.content.includes("2026-09-30")),
        chatBCurrentValue: /2026-09-30|september 30/i.test(textOutput(chatBResult.events)),
        chatBNoToolClaim: toolNames(chatBResult.events).length === 0,
        chatCSearchStarted: chatCResult.events.some((event) => event.type === "tool_started" && event.toolName === "search_messages"),
        chatCSearchFinished: hasFinishedTool(chatCResult.events, "search_messages", () => true) || hasFinishedTool(chatCResult.events, "read_messages", () => true),
        validatedHistoricalSourceAction: Boolean(sourceRow && validateOpenMessageAction(sourceRow.action) && oldMessageIds.includes(sourceRow.action.messageId)),
        oldContextHasCollapsedCorrection: changeHint.changes.some((change) => change.canonicalKey === canonicalKey && change.content.includes("2026-09-30")) && buildDynamicSystemPrompt(oldContext).includes("memory-changes"),
        oldChatFollowsCorrection: /2026-09-30|september 30/i.test(textOutput(oldResult.events)),
        archiveApplied: archiveResult.status === "applied",
        archivedDocumentAbsentFromActiveContext: activeAfterArchive === null,
        rawTaggedHistoryPresent: rawSourceStillPresent,
      };
      acceptanceReport = {
        status: Object.values(assertions).every(Boolean) ? "passed" : "failed",
        model: getConfiguredModelName(),
        requestCount: providerCalls,
        observedToolNames: toolNames(observedEvents),
        assertions,
      };
    } catch (error) {
      failureCode = errorCode(error);
      throw error;
    } finally {
      globalThis.fetch = originalFetch;
      try {
        await cleanup(ledgerPath, ledger);
        const after = await aggregate();
        const cleanupReturnedToBaseline = baseline ? sameAggregate(baseline, after) : false;
        if (acceptanceReport) {
          const assertions = { ...(acceptanceReport.assertions as Record<string, boolean>), cleanupReturnedToBaseline };
          const status = Object.values(assertions).every(Boolean) ? "passed" : "failed";
          writeReport({ ...acceptanceReport, status, assertions, ...(status === "failed" ? { errorCode: "assertion_failed" } : {}) });
          expect(status).toBe("passed");
        } else {
          writeReport({ status: "failed", model: getConfiguredModelName(), requestCount: providerCalls, observedToolNames: toolNames(observedEvents), errorCode: failureCode ?? (cleanupReturnedToBaseline ? "acceptance_failed" : "cleanup_mismatch"), assertions: { cleanupReturnedToBaseline } });
        }
      } catch (cleanupError) {
        writeReport({ status: "failed", model: getConfiguredModelName(), requestCount: providerCalls, observedToolNames: toolNames(observedEvents), errorCode: errorCode(cleanupError), assertions: { cleanupReturnedToBaseline: false } });
        throw cleanupError;
      }
    }
  });
});
