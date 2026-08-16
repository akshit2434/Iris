import { describe, expect, it, vi } from "vitest";
import { createMemoryArchiveService } from "@/server/memory/archive";
import type { MemoryItem, MemoryStore } from "@/server/memory/types";

const ids = { thread: "00000000-0000-4000-8000-000000000001", message: "00000000-0000-4000-8000-000000000002", run: "00000000-0000-4000-8000-000000000003" };
function makeItem(itemRevision = 2): MemoryItem { return { id: "00000000-0000-4000-8000-000000000010", profileId: "profile-a", canonicalKey: "profile.communication", content: "The user prefers concise answers.", itemRevision, category: "preference", valueScope: "single", origin: "explicit", confidence: 1, importance: 0.5, sensitivity: "normal", status: "active", validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, createdAt: "now", updatedAt: "now", archivedAt: null, deletedAt: null }; }
function makeStore(item = makeItem()): MemoryStore {
  return {
    listItems: vi.fn(async () => [item]), getItem: vi.fn(async () => item), getCurrentRevision: vi.fn(async () => 2),
    readMessageContext: vi.fn(async () => ({ thread: { id: ids.thread, profileId: "profile-a" as const, title: "Test", createdAt: "now", updatedAt: "now" }, target: { messageId: ids.message, threadId: ids.thread, profileId: "profile-a" as const, role: "user" as const, content: "Forget that", createdAt: "now" }, before: [], after: [] })),
    applyItemRevision: vi.fn(async (input) => ({ profileId: input.profileId, itemId: item.id, canonicalKey: input.canonicalKey, itemRevision: 3, profileGlobalRevision: 3, revisionId: "00000000-0000-4000-8000-000000000021", sourceId: "00000000-0000-4000-8000-000000000022", contentHash: "a".repeat(64) })),
    createSuppression: vi.fn(async () => "00000000-0000-4000-8000-000000000023"), searchMessages: vi.fn(async () => []), searchItems: vi.fn(async () => []),
  } as unknown as MemoryStore;
}

describe("governed memory archive", () => {
  it("archives only through active message provenance and creates suppression", async () => {
    const store = makeStore();
    const result = await createMemoryArchiveService(store).archive({ profileId: "profile-a", threadId: ids.thread, currentUserMessageId: ids.message, agentRunId: ids.run, toolCallId: "call-1", canonicalKey: "profile.communication", expectedItemRevision: 2, reason: "No longer current" });
    expect(result).toMatchObject({ status: "applied", canonicalKey: "profile.communication" });
    expect(store.applyItemRevision).toHaveBeenCalledWith(expect.objectContaining({ mutationKind: "archive", expectedItemRevision: 2, content: "The user prefers concise answers.", status: "archived" }));
    expect(store.createSuppression).toHaveBeenCalledWith(expect.objectContaining({ canonicalKey: "profile.communication" }));
  });

  it("returns stale without mutating when the revision changed", async () => {
    const store = makeStore(makeItem(3));
    const result = await createMemoryArchiveService(store).archive({ profileId: "profile-a", threadId: ids.thread, currentUserMessageId: ids.message, agentRunId: ids.run, toolCallId: "call-1", canonicalKey: "profile.communication", expectedItemRevision: 2 });
    expect(result.status).toBe("stale");
    expect(store.applyItemRevision).not.toHaveBeenCalled();
  });
});
