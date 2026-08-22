import { describe, expect, it, vi } from "vitest";
import { patchMemory, searchMessages } from "@/server/agent/tools";
import type { AgentContext } from "@/server/agent/context";
import type { MemoryRetrieval } from "@/server/memory/retrieval";
import type { GovernedMemoryPatchInput, GovernedMemoryPatchResult } from "@/server/memory/mutation";

const THREAD_ID = "55555555-5555-4555-8555-555555555555";

const context = {
  profileId: "profile-a",
  threadId: THREAD_ID,
  currentUserMessageId: "22222222-2222-4222-8222-222222222222",
  agentRunId: "33333333-3333-4333-8333-333333333333",
  historicalPreflightSources: [],
  memoryControls: { savedMemoryEnabled: true, referenceHistoryEnabled: true },
} as unknown as AgentContext;

const baseInput = {
  canonicalKey: "user.test_fact",
  content: "The user test fact is true.",
  expectedItemRevision: 3 as number | null,
  mutationKind: "update" as const,
  category: "personal_fact" as const,
  valueScope: "single" as const,
};

const APPLIED_REVISION = {
  itemRevision: 7,
  profileGlobalRevision: 21,
  revisionId: "rev-7",
  profileId: "profile-a" as const,
  itemId: "item-1",
  canonicalKey: baseInput.canonicalKey,
  sourceId: "src-1",
  contentHash: "hash",
};

function appliedResult(canonicalKey: string, itemRevision: number): GovernedMemoryPatchResult {
  return { status: "applied", canonicalKey, revision: { ...APPLIED_REVISION, canonicalKey, itemRevision } };
}

function staleResult(canonicalKey: string): GovernedMemoryPatchResult {
  return { status: "stale", canonicalKey, reason: "The memory item changed; reread it before updating.", candidates: [canonicalKey] };
}

describe("memory patch hardening", () => {
  it("auto-heals a stale expected revision by re-reading and retrying once", async () => {
    const seenRevisions: Array<number | null> = [];
    const apply = vi.fn(async (input: GovernedMemoryPatchInput): Promise<GovernedMemoryPatchResult> => {
      seenRevisions.push(input.expectedItemRevision);
      return seenRevisions.length === 1 ? staleResult(baseInput.canonicalKey) : appliedResult(baseInput.canonicalKey, 7);
    });
    const readMemory = vi.fn(async () => ({ canonicalKey: baseInput.canonicalKey, itemRevision: 7, updatedAt: "2026-08-22T00:00:00Z", content: "", category: "personal_fact", status: "active", archivedAt: null }));
    const retrieval = { readMemory } as unknown as MemoryRetrieval;

    const output = await patchMemory(context, baseInput, { apply }, "tool-call-1", retrieval);

    expect(output.status).toBe("applied");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(seenRevisions).toEqual([3, 7]);
    expect(readMemory).toHaveBeenCalledWith(context.profileId, baseInput.canonicalKey);
  });

  it("never retries create patches", async () => {
    const apply = vi.fn(async (_input: GovernedMemoryPatchInput): Promise<GovernedMemoryPatchResult> => staleResult(baseInput.canonicalKey));
    const readMemory = vi.fn();
    const output = await patchMemory(
      context,
      { ...baseInput, mutationKind: "create", expectedItemRevision: null },
      { apply },
      "tool-call-2",
      { readMemory } as unknown as MemoryRetrieval,
    );
    expect(output.status).toBe("stale");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(readMemory).not.toHaveBeenCalled();
  });

  it("serializes concurrent patches for the same profile", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const apply = vi.fn(async (input: GovernedMemoryPatchInput): Promise<GovernedMemoryPatchResult> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25));
      inFlight -= 1;
      return appliedResult(input.canonicalKey, input.expectedItemRevision ?? 9);
    });
    await Promise.all([
      patchMemory(context, baseInput, { apply }, "t-a"),
      patchMemory(context, { ...baseInput, canonicalKey: "user.other_fact" }, { apply }, "t-b"),
    ]);
    expect(maxInFlight).toBe(1);
  });
});

const SEARCH_HIT = {
  messageId: "44444444-4444-4444-8444-444444444444",
  threadId: THREAD_ID,
  profileId: "profile-a" as const,
  role: "user" as const,
  content: "qr stickers idea",
  createdAt: "2026-08-10T18:10:09Z",
};

type SearchCall = { roles?: string[]; matchType?: string };
function makeRetrieval(batches: Array<Array<typeof SEARCH_HIT>>) {
  let call = 0;
  const searchMessagesMock = vi.fn((_input: SearchCall) => Promise.resolve(batches[Math.min(call++, batches.length - 1)] ?? []));
  const readWindow = async (_profileId: string, messageId: string) => ({
    thread: { id: THREAD_ID, profileId: "profile-a" as const, title: "T", createdAt: "2026-08-01T00:00:00Z", updatedAt: "2026-08-01T00:00:00Z" },
    target: { messageId, threadId: THREAD_ID, profileId: "profile-a" as const, role: "user" as const, content: "x", createdAt: "2026-08-01T00:00:00Z" },
    before: [],
    after: [],
  });
  return { retrieval: { searchMessages: searchMessagesMock, readMessages: vi.fn(readWindow) } as unknown as MemoryRetrieval, searchMessagesMock };
}

function strategyNoteOf(output: Awaited<ReturnType<typeof searchMessages>>): string | undefined {
  return "strategyNote" in output ? output.strategyNote : undefined;
}

describe("zero-hit search escalation", () => {
  it("drops role restriction on the first zero-hit attempt", async () => {
    const { retrieval, searchMessagesMock } = makeRetrieval([[], [SEARCH_HIT]]);
    const output = await searchMessages(context, { query: "qr stickers", roles: ["assistant"], limit: 5 }, retrieval);
    expect(output.results).toHaveLength(1);
    expect(strategyNoteOf(output)).toContain("role-free");
    expect((searchMessagesMock.mock.calls[0]?.[0] as { roles?: string[] }).roles).toEqual(["assistant"]);
    expect((searchMessagesMock.mock.calls[1]?.[0] as unknown as { roles?: string[] }).roles).toBeUndefined();
  });

  it("falls back to hybrid semantic on persistent lexical misses", async () => {
    const { retrieval, searchMessagesMock } = makeRetrieval([[], [], [SEARCH_HIT]]);
    const output = await searchMessages(context, { query: "qr thingy", roles: ["assistant"], matchType: "exact_phrase", limit: 5 }, retrieval);
    expect(output.results).toHaveLength(1);
    expect(strategyNoteOf(output)).toContain("semantic fallback");
    expect((searchMessagesMock.mock.calls[2]?.[0] as { matchType?: string }).matchType).toBe("hybrid");
  });

  it("does not escalate when the first attempt already has hits", async () => {
    const { retrieval, searchMessagesMock } = makeRetrieval([[SEARCH_HIT]]);
    const output = await searchMessages(context, { query: "qr stickers", roles: ["user"], limit: 5 }, retrieval);
    expect(output.results).toHaveLength(1);
    expect(strategyNoteOf(output)).toBeUndefined();
    expect(searchMessagesMock).toHaveBeenCalledTimes(1);
  });

  it("returns empty without strategy note when every attempt misses", async () => {
    const { retrieval } = makeRetrieval([[], [], []]);
    const output = await searchMessages(context, { query: "nothing matches this", roles: ["assistant"], limit: 5 }, retrieval);
    expect(output.results).toHaveLength(0);
    expect(strategyNoteOf(output)).toBeUndefined();
  });
});
