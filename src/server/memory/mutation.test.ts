import { describe, expect, it, vi } from "vitest";
import { createMemoryMutationService } from "@/server/memory/mutation";
import type { MemoryItem, MemoryStore } from "@/server/memory/types";

const ids = { thread: "00000000-0000-4000-8000-000000000001", message: "00000000-0000-4000-8000-000000000002", run: "00000000-0000-4000-8000-000000000003" };
const base = { profileId: "profile-a" as const, threadId: ids.thread, currentUserMessageId: ids.message, agentRunId: ids.run, toolCallId: "call-1", canonicalKey: "profile.communication", content: "The user prefers concise answers.", expectedItemRevision: null, mutationKind: "create" as const };

function makeItem(itemRevision = 1): MemoryItem {
  return { id: "00000000-0000-4000-8000-000000000010", profileId: "profile-a", canonicalKey: "profile.communication", content: "old", itemRevision, category: "preference", valueScope: "single", origin: "explicit", confidence: 1, importance: 0.5, sensitivity: "normal", status: "active", validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, createdAt: "now", updatedAt: "now", archivedAt: null, deletedAt: null };
}

function store(items: MemoryItem[] = []): MemoryStore {
  return {
    listItems: vi.fn(async () => items), getItem: vi.fn(async () => null), getCurrentRevision: vi.fn(async () => 0),
    readMessageContext: vi.fn(async () => ({ thread: { id: ids.thread, profileId: "profile-a" as const, title: "Test", createdAt: "now", updatedAt: "now" }, target: { messageId: ids.message, threadId: ids.thread, profileId: "profile-a" as const, role: "user" as const, content: "Remember this", createdAt: "now" }, before: [], after: [] })),
    applyItemRevision: vi.fn(async (input) => ({ profileId: input.profileId, itemId: "00000000-0000-4000-8000-000000000020", canonicalKey: input.canonicalKey, itemRevision: 1, profileGlobalRevision: 1, revisionId: "00000000-0000-4000-8000-000000000021", sourceId: "00000000-0000-4000-8000-000000000022", contentHash: "a".repeat(64) })),
    searchMessages: vi.fn(async () => []), searchItems: vi.fn(async () => []),
  } as unknown as MemoryStore;
}

describe("governed structured memory mutation", () => {
  it("applies only with current user-message provenance", async () => {
    const memoryStore = store();
    memoryStore.liftSuppression = vi.fn(async () => 1);
    const result = await createMemoryMutationService(memoryStore).apply(base);
    expect(result).toMatchObject({ status: "applied", canonicalKey: "profile.communication" });
    expect(memoryStore.applyItemRevision).toHaveBeenCalledWith(expect.objectContaining({ canonicalKey: "profile.communication", content: base.content, origin: "explicit", status: "active" }));
    expect(memoryStore.liftSuppression).toHaveBeenCalledWith("profile-a", "profile.communication");
  });

  it("rejects stale revisions and oversized content without writing", async () => {
    const memoryStore = store([makeItem(4)]);
    await expect(createMemoryMutationService(memoryStore).apply({ ...base, mutationKind: "update", expectedItemRevision: 3 })).resolves.toMatchObject({ status: "stale" });
    await expect(createMemoryMutationService(store()).apply({ ...base, content: "x".repeat(20_001) })).resolves.toMatchObject({ status: "conflict" });
  });

  it("rejects malformed or foreign provenance", async () => {
    const memoryStore = store();
    vi.mocked(memoryStore.readMessageContext!).mockResolvedValue(null);
    await expect(createMemoryMutationService(memoryStore).apply(base)).resolves.toMatchObject({ status: "conflict" });
  });

  it("records corrections as superseding provenance while keeping one active canonical item", async () => {
    const memoryStore = store([makeItem(4)]);
    memoryStore.liftSuppression = vi.fn(async () => 0);
    const result = await createMemoryMutationService(memoryStore).apply({
      ...base,
      mutationKind: "supersede",
      expectedItemRevision: 4,
      content: "The user now prefers concise answers with direct recommendations.",
    });
    expect(result).toMatchObject({ status: "applied" });
    expect(memoryStore.applyItemRevision).toHaveBeenCalledWith(expect.objectContaining({
      mutationKind: "supersede",
      expectedItemRevision: 4,
      provenance: expect.objectContaining({ relation: "corrects" }),
    }));
  });

  it("restores an archived item only through an explicit write and lifts suppression", async () => {
    const archived = { ...makeItem(3), status: "archived" as const, archivedAt: "yesterday" };
    const memoryStore = store([archived]);
    memoryStore.liftSuppression = vi.fn(async () => 1);
    const result = await createMemoryMutationService(memoryStore).apply({
      ...base,
      content: "The user prefers concise answers again.",
    });
    expect(result).toMatchObject({ status: "applied" });
    expect(memoryStore.applyItemRevision).toHaveBeenCalledWith(expect.objectContaining({ mutationKind: "restore", expectedItemRevision: 3 }));
    expect(memoryStore.liftSuppression).toHaveBeenCalledWith("profile-a", "profile.communication");
  });

  it("does not race two writes past the database revision guard", async () => {
    const memoryStore = store([makeItem(4)]);
    let writes = 0;
    vi.mocked(memoryStore.applyItemRevision).mockImplementation(async () => {
      writes += 1;
      if (writes > 1) throw new Error("Stale memory item revision");
      return { profileId: "profile-a", itemId: "00000000-0000-4000-8000-000000000020", canonicalKey: "profile.communication", itemRevision: 5, profileGlobalRevision: 5, revisionId: "00000000-0000-4000-8000-000000000021", sourceId: "00000000-0000-4000-8000-000000000022", contentHash: "a".repeat(64) };
    });
    const service = createMemoryMutationService(memoryStore);
    const results = await Promise.all([
      service.apply({ ...base, mutationKind: "supersede", expectedItemRevision: 4, content: "New answer style A." }),
      service.apply({ ...base, toolCallId: "call-2", mutationKind: "supersede", expectedItemRevision: 4, content: "New answer style B." }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["applied", "stale"]);
  });

  it("rejects a credential before the store is called", async () => {
    const memoryStore = store();
    const result = await createMemoryMutationService(memoryStore).apply({ ...base, content: "Remember my password: hunter2" });
    expect(result).toMatchObject({ status: "conflict" });
    expect(memoryStore.applyItemRevision).not.toHaveBeenCalled();
  });
});
