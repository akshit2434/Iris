import { describe, expect, it, vi } from "vitest";
import { detectHistoryPreflightIntent, formatHistoryPreflightPrompt, runHistoryPreflight } from "@/server/memory/history-preflight";
import type { MemoryRetrieval } from "@/server/memory/retrieval";
import type { MessageContextWindow, MessageSearchResult, ReferenceHistorySnapshot } from "@/server/memory/types";

const ids = {
  thread: "00000000-0000-4000-8000-000000000011",
  message: "00000000-0000-4000-8000-000000000010",
};

function result(overrides: Partial<MessageSearchResult> = {}): MessageSearchResult {
  return {
    messageId: ids.message,
    threadId: ids.thread,
    profileId: "profile-a",
    role: "user",
    content: "I decided to ship Project Ember on September 30.",
    createdAt: "2026-08-14T12:00:00.000Z",
    lexicalScore: 1,
    semanticScore: null,
    combinedScore: 1,
    ...overrides,
  };
}

function window(overrides: Partial<MessageContextWindow> = {}): MessageContextWindow {
  return {
    thread: { id: ids.thread, profileId: "profile-a", title: "Ember decision", createdAt: "2026-08-14T11:00:00.000Z", updatedAt: "2026-08-14T12:00:00.000Z" },
    target: { messageId: ids.message, threadId: ids.thread, profileId: "profile-a", role: "user", content: "I decided to ship Project Ember on September 30.", createdAt: "2026-08-14T12:00:00.000Z" },
    before: [],
    after: [],
    ...overrides,
  };
}

function retrieval(results: MessageSearchResult[] = [result()], context: MessageContextWindow | null = window()): MemoryRetrieval {
  return {
    searchMessages: vi.fn(async () => results),
    readMessages: vi.fn(async () => context),
    listMemory: vi.fn(async () => []),
    currentRevision: vi.fn(async () => 0),
    readMemory: vi.fn(async () => null),
    searchMemory: vi.fn(async () => []),
  };
}

describe("deterministic historical preflight", () => {
  it("detects evidence, exact-source, date, role, and continuation intent", () => {
    expect(detectHistoryPreflightIntent("Where did I decide Project Ember?", new Date("2026-08-16T00:00:00.000Z"))).toMatchObject({ kind: "evidence", roles: ["user"], matchType: "hybrid" });
    expect(detectHistoryPreflightIntent('Show the exact message where I said "ship Ember"')).toMatchObject({ kind: "exact_source", exactPhrase: "ship Ember", matchType: "exact_phrase" });
    expect(detectHistoryPreflightIntent("What did I decide last month?", new Date("2026-08-16T00:00:00.000Z"))).toMatchObject({ from: "2026-07-01T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" });
    expect(detectHistoryPreflightIntent("Which old chat should I continue?", new Date("2026-08-16T00:00:00.000Z"))).toMatchObject({ kind: "continuation" });
    expect(detectHistoryPreflightIntent("Explain what a database index is.")).toBeNull();
  });

  it("preflights even when the model would choose a different tool and returns an exact action", async () => {
    const store = retrieval();
    const output = await runHistoryPreflight({ profileId: "profile-a", query: "Where did I decide Project Ember?", retrieval: store, now: new Date("2026-08-16T00:00:00.000Z") });
    expect(store.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-a", roles: ["user"], matchType: "hybrid" }));
    expect(store.readMessages).toHaveBeenCalledWith("profile-a", ids.message, 2);
    expect(output.status).toBe("found");
    expect(output.sources[0]?.action).toEqual({ type: "open_message", threadId: ids.thread, messageId: ids.message, label: "Open source" });
    expect(output.prompt).toContain("Historical preflight status: found");
    expect(output.prompt).toContain(ids.message);
    expect(output.prompt).toContain("validated open_message action");
    expect(output.prompt).toContain("never claim that navigation is unavailable");
  });

  it("resolves explicit source requests from Dreaming claim provenance before raw search", async () => {
    const store = retrieval();
    const snapshot = {
      id: "00000000-0000-4000-8000-000000000031",
      profileId: "profile-a",
      revision: 2,
      status: "active",
      document: {
        version: "iris-reference-history-v1",
        ongoingWork: [{ text: "The blue-awning bookshop has a reading corner.", confidence: 0.9, temporalQualifier: "tentative", sourceMessageIds: [ids.message], memoryKeys: [] }],
        recurringPreferences: [], relationshipsContext: [], recentChanges: [], boundedPatterns: [], renderedText: "",
      },
      renderedText: "",
      sourceRanges: [],
      coveredTokenWatermark: 200,
      coveredThroughAt: "2026-08-14T12:00:00.000Z",
      sourceHash: "hash",
      memoryRevision: 0,
      model: "openai/test-model",
      synthesizerVersion: "iris-reference-history-v1",
      previousSnapshotId: null,
      createdAt: "2026-08-14T12:00:00.000Z",
    } satisfies ReferenceHistorySnapshot;
    const output = await runHistoryPreflight({ profileId: "profile-a", query: "where did we talk about the blue-awning bookshop?", retrieval: store, referenceHistorySnapshot: snapshot });
    expect(output.status).toBe("found");
    expect(output.sources[0]?.action).toEqual({ type: "open_message", threadId: ids.thread, messageId: ids.message, label: "Open source" });
    expect(store.searchMessages).not.toHaveBeenCalled();
  });

  it("does not turn the current request into its own historical source", async () => {
    const currentMessage = "00000000-0000-0000-0000-000000000099";
    const sourceMessage = ids.message;
    const store = retrieval([
      result({ messageId: currentMessage, content: "Where did I decide Project Ember?" }),
      result({ messageId: sourceMessage }),
    ]);
    const read = store.readMessages as ReturnType<typeof vi.fn>;
    read.mockImplementation(async (_profile: string, messageId: string) => window({
      target: { ...window().target, messageId, content: messageId === sourceMessage ? window().target.content : "Where did I decide Project Ember?" },
    }));
    const output = await runHistoryPreflight({ profileId: "profile-a", query: "Where did I decide Project Ember?", retrieval: store, excludeMessageId: currentMessage });
    expect(output.status).toBe("found");
    expect(output.sources).toHaveLength(1);
    expect(output.sources[0]?.messageId).toBe(sourceMessage);
    expect(read).toHaveBeenCalledWith("profile-a", sourceMessage, 2);
    expect(read).not.toHaveBeenCalledWith("profile-a", currentMessage, 2);
  });

  it("honestly distinguishes no match from unavailable search", async () => {
    const noMatch = await runHistoryPreflight({ profileId: "profile-a", query: "Find the exact source of a missing decision.", retrieval: retrieval([], null) });
    expect(noMatch.status).toBe("no_match");
    expect(noMatch.prompt).toContain("No matching retained source was found");
    expect(noMatch.prompt).toContain("do not claim the event never happened");
    const unavailable = await runHistoryPreflight({ profileId: "profile-a", query: "Find the old chat about a missing decision.", retrieval: { ...retrieval(), searchMessages: vi.fn(async () => { throw new Error("db offline"); }) } });
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.prompt).toContain("search was unavailable");
  });

  it("returns ambiguous continuation candidates with independent actions", async () => {
    const secondThread = "00000000-0000-4000-8000-000000000021";
    const secondMessage = "00000000-0000-4000-8000-000000000020";
    const store = retrieval([
      result(),
      result({ threadId: secondThread, messageId: secondMessage, content: "A second plausible continuation." }),
    ]);
    const read = store.readMessages as ReturnType<typeof vi.fn>;
    read.mockImplementation(async (_profile: string, messageId: string) => window({
      thread: { id: messageId === secondMessage ? secondThread : ids.thread, profileId: "profile-a", title: messageId === secondMessage ? "Second chat" : "First chat", createdAt: "2026-08-14T11:00:00.000Z", updatedAt: "2026-08-14T12:00:00.000Z" },
      target: { ...window().target, messageId, threadId: messageId === secondMessage ? secondThread : ids.thread },
    }));
    const output = await runHistoryPreflight({ profileId: "profile-a", query: "Which old chat should I continue?", retrieval: store });
    expect(output.status).toBe("ambiguous");
    expect(output.sources).toHaveLength(2);
    expect(output.prompt).toContain("Several plausible continuation sources matched");
  });

  it("rejects cross-profile and deleted sources during reconstruction", async () => {
    const crossProfile = retrieval([result({ profileId: "profile-b" })], window({ target: { ...window().target, profileId: "profile-b" } }));
    const output = await runHistoryPreflight({ profileId: "profile-a", query: "Show the exact source.", retrieval: crossProfile });
    expect(output.status).toBe("no_match");
    expect(output.sources).toEqual([]);
    const deleted = retrieval([result()], null);
    await expect(runHistoryPreflight({ profileId: "profile-a", query: "Show the exact source.", retrieval: deleted })).resolves.toMatchObject({ status: "no_match", sources: [] });
  });

  it("keeps the prompt bounded for large source content", () => {
    const output = formatHistoryPreflightPrompt({
      triggered: true,
      intent: { kind: "evidence", query: "decision", exactPhrase: null, matchType: "hybrid", roles: null, from: null, to: null, trigger: "test" },
      status: "found",
      sources: Array.from({ length: 3 }, (_, index) => ({
        ...result({ messageId: `00000000-0000-4000-8000-00000000001${index}` }),
        threadTitle: "Chat",
        excerpt: "x".repeat(1000),
        action: { type: "open_message" as const, threadId: ids.thread, messageId: ids.message, label: "Open source" },
        surrounding: { before: [], after: [] },
      })),
      prompt: "",
    });
    expect(output.length).toBeLessThanOrEqual(10_000);
  });
});
