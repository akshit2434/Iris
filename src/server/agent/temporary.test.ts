import { describe, expect, it, vi } from "vitest";
import { createDisabledMemoryMutation, createDisabledMemoryRetrieval } from "@/server/memory/disabled";
import { createTemporaryAgentResponse, sanitizeTemporaryHistory, validateTemporaryId } from "@/server/agent/temporary";

const streamAgentEventsMock = vi.hoisted(() => vi.fn());

vi.mock("@/server/agent", () => ({
  getConfiguredModelName: () => "test-model",
  streamAgentEvents: streamAgentEventsMock,
}));

describe("temporary chat boundaries", () => {
  it("accepts only bounded user/assistant history and drops tool or empty rows", () => {
    const history = sanitizeTemporaryHistory([
      { role: "user", content: "One" },
      { role: "tool", content: "private event" },
      { role: "assistant", content: "Two" },
      { role: "user", content: "" },
    ]);
    expect(history).toHaveLength(2);
    expect(history?.map((row) => row.role)).toEqual(["user", "assistant"]);
  });

  it("does not accept a caller-controlled non-UUID temporary identity", () => {
    expect(validateTemporaryId("not-an-id")).toMatch(/^[0-9a-f-]{36}$/i);
    expect(validateTemporaryId("00000000-0000-4000-8000-000000000001")).toBe("00000000-0000-4000-8000-000000000001");
  });

  it("makes disabled memory inert for reads and writes", async () => {
    const retrieval = createDisabledMemoryRetrieval();
    expect(await retrieval.listMemory("profile-a")).toEqual([]);
    expect(await retrieval.searchMessages({ profileId: "profile-a", query: "secret" })).toEqual([]);
    const result = await createDisabledMemoryMutation().apply({
      profileId: "profile-a",
      threadId: "00000000-0000-4000-8000-000000000001",
      currentUserMessageId: "00000000-0000-4000-8000-000000000002",
      agentRunId: "00000000-0000-4000-8000-000000000003",
      toolCallId: "call",
      canonicalKey: "profile.secret",
      content: "Do not save",
      expectedItemRevision: null,
      mutationKind: "create",
    });
    expect(result.status).toBe("conflict");
  });

  it("disables accountability tools alongside the memory families in temporary chats", async () => {
    streamAgentEventsMock.mockImplementation(async function* () {});
    const response = createTemporaryAgentResponse({
      profileId: "profile-a",
      profileLabel: "Profile A",
      temporaryId: "00000000-0000-4000-8000-000000000010",
      requestId: "request-1",
      content: "Hello",
      timezone: "UTC",
    });
    await response.text();
    expect(streamAgentEventsMock).toHaveBeenCalledTimes(1);
    expect(streamAgentEventsMock.mock.calls[0]?.[0]).toMatchObject({
      savedMemoryEnabled: false,
      referenceHistoryEnabled: false,
      accountabilityEnabled: false,
    });
  });
});
