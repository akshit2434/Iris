import { describe, expect, it, vi } from "vitest";
import { createMemoryRetrievalService } from "@/server/memory/retrieval";
import type { MemoryItemAudit, MemoryStore, MessageContextWindow } from "@/server/memory/types";

function store(): MemoryStore {
  return {
    listItems: vi.fn(async () => []), getItem: vi.fn(async () => null), getCurrentRevision: vi.fn(async () => 0), applyItemRevision: vi.fn(),
    searchMessages: vi.fn(async () => []), readMessageContext: vi.fn(async () => null), searchItems: vi.fn(async () => []),
  } as unknown as MemoryStore;
}

describe("profile-scoped memory retrieval", () => {
  it("normalizes lexical search and never asks for an embedding by default", async () => {
    const memoryStore = store();
    const service = createMemoryRetrievalService({ store: memoryStore });
    await service.searchMessages({ profileId: "profile-a", query: "  prior   decision  ", limit: 3 });
    expect(memoryStore.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-a", query: "prior decision", queryEmbedding: null, limit: 3 }));
  });

  it("keeps the optional semantic path injected and bounded", async () => {
    const memoryStore = store();
    const provider = { model: "test-embedding", embed: vi.fn(async () => [Array.from({ length: 1536 }, () => 0)]) };
    const service = createMemoryRetrievalService({ store: memoryStore, semanticSearchEnabled: true, semanticQueryProvider: provider });
    await service.searchMessages({ profileId: "profile-a", query: "roadmap", limit: 2 });
    expect(provider.embed).toHaveBeenCalledWith(["roadmap"]);
    expect(memoryStore.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: expect.any(Array), limit: 2 }));
  });

  it("keeps current-thread echoes from crowding out cross-chat evidence", async () => {
    const currentThreadId = "00000000-0000-4000-8000-000000000001";
    const olderThreadId = "00000000-0000-4000-8000-000000000002";
    const memoryStore = store();
    vi.mocked(memoryStore.searchMessages).mockResolvedValue([
      ...Array.from({ length: 10 }, (_, index) => ({
        messageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        threadId: currentThreadId,
        profileId: "profile-a" as const,
        role: "user" as const,
        content: "current echo",
        createdAt: "2026-08-16T00:00:00.000Z",
        lexicalScore: 1,
        semanticScore: null,
        combinedScore: 1,
      })),
      {
        messageId: "00000000-0000-4000-8000-000000000099",
        threadId: olderThreadId,
        profileId: "profile-a",
        role: "user",
        content: "older evidence",
        createdAt: "2026-08-15T00:00:00.000Z",
        lexicalScore: 0.5,
        semanticScore: null,
        combinedScore: 0.5,
      },
    ]);
    const service = createMemoryRetrievalService({ store: memoryStore, semanticSearchEnabled: false });
    await expect(service.searchMessages({ profileId: "profile-a", query: "device context", excludeThreadId: currentThreadId, limit: 5 }))
      .resolves.toEqual([expect.objectContaining({ threadId: olderThreadId })]);
    expect(memoryStore.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ limit: 25 }));
  });

  it("falls back to lexical search when the semantic provider is unavailable", async () => {
    const memoryStore = store();
    const provider = { model: "test-embedding", embed: vi.fn(async () => { throw new Error("embedding unavailable"); }) };
    const service = createMemoryRetrievalService({ store: memoryStore, semanticSearchEnabled: true, semanticQueryProvider: provider });
    await service.searchMessages({ profileId: "profile-a", query: "roadmap", matchType: "semantic", roles: ["user"], limit: 2 });
    expect(provider.embed).toHaveBeenCalledWith(["roadmap"]);
    expect(memoryStore.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ queryEmbedding: null, matchType: "semantic", roles: ["user"], limit: 2 }));
  });

  it("rejects invalid date ranges and malformed exact IDs before the store", async () => {
    const memoryStore = store();
    const service = createMemoryRetrievalService({ store: memoryStore });
    await expect(service.searchMessages({ profileId: "profile-a", query: "x", from: "2026-08-02T00:00:00.000Z", to: "2026-08-01T00:00:00.000Z" })).rejects.toThrow("before");
    await expect(service.readMessages("profile-a", "bad")).rejects.toThrow("UUID");
    expect(memoryStore.searchMessages).not.toHaveBeenCalled();
  });

  it("keeps structured memory search lexical and profile-scoped", async () => {
    const memoryStore = store();
    const service = createMemoryRetrievalService({ store: memoryStore });
    await service.searchMemory("profile-b", "roadmap", 2);
    expect(memoryStore.searchItems).toHaveBeenCalledWith("profile-b", "roadmap", 2);
  });

  it("resolves canonical memory provenance to the original profile-owned user assertion", async () => {
    const memoryStore = store();
    const sourceMessageId = "00000000-0000-4000-8000-000000000031";
    const threadId = "00000000-0000-4000-8000-000000000032";
    memoryStore.getItemAudit = vi.fn(async () => ({
      item: { id: "item", profileId: "profile-a", canonicalKey: "profile.machine", content: "The user owns a LunarBook 14.", itemRevision: 2, category: "personal_fact", valueScope: "single", origin: "inferred", confidence: 0.9, importance: 0.7, sensitivity: "normal", status: "active", validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, createdAt: "2026-08-15T12:00:00.000Z", updatedAt: "2026-08-15T12:00:00.000Z", archivedAt: null, deletedAt: null },
      revisions: [{ id: "revision", profileId: "profile-a", itemId: "item", itemRevision: 2, profileGlobalRevision: 2, canonicalKey: "profile.machine", content: "The user owns a LunarBook 14.", contentHash: "a".repeat(64), category: "personal_fact", valueScope: "single", origin: "inferred", confidence: 0.9, importance: 0.7, sensitivity: "normal", status: "active", validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, mutationKind: "update", idempotencyKey: null, createdAt: "2026-08-15T12:00:00.000Z", sources: [{ id: "source", sourceKind: "message", sourceThreadId: threadId, sourceMessageId, sourceAgentEventId: null, sourceAgentRunId: null, sourceExcerpt: null, metadata: {}, relation: "supports", createdAt: "2026-08-15T12:00:00.000Z" }] }],
    } satisfies MemoryItemAudit));
    memoryStore.readMessageContext = vi.fn(async () => ({
      thread: { id: threadId, profileId: "profile-a", title: "Machine note", createdAt: "2026-08-15T11:00:00.000Z", updatedAt: "2026-08-15T12:00:00.000Z" },
      target: { messageId: sourceMessageId, threadId, profileId: "profile-a", role: "user", content: "My laptop is a LunarBook 14.", createdAt: "2026-08-15T12:00:00.000Z" },
      before: [], after: [],
    } satisfies MessageContextWindow));
    const service = createMemoryRetrievalService({ store: memoryStore });
    await expect(service.memorySources?.("profile-a", "profile.machine", 3)).resolves.toEqual([
      expect.objectContaining({ messageId: sourceMessageId, role: "user", content: "My laptop is a LunarBook 14.", threadTitle: "Machine note" }),
    ]);
    expect(memoryStore.readMessageContext).toHaveBeenCalledWith("profile-a", sourceMessageId, 1);
  });
});
