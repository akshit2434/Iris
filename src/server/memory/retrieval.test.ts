import { describe, expect, it, vi } from "vitest";
import { createMemoryRetrievalService } from "@/server/memory/retrieval";
import type { MemoryStore } from "@/server/memory/types";

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
});
