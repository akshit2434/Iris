import { describe, expect, it, vi } from "vitest";
import { createMemoryRetrievalService } from "@/server/memory/retrieval";
import { MEMORY_EMBEDDING_DIMENSIONS, type MemoryStore } from "@/server/memory/types";
import type { EmbeddingProvider } from "@/server/memory/embeddings";

const messageId = "00000000-0000-4000-8000-000000000010";
const threadId = "00000000-0000-4000-8000-000000000011";

function makeStore(overrides: Partial<MemoryStore> = {}): MemoryStore {
  return {
    listDocuments: vi.fn(async () => []),
    getDocument: vi.fn(async () => null),
    getCurrentRevision: vi.fn(async () => 0),
    applyDocumentRevision: vi.fn(),
    searchMessages: vi.fn(async () => []),
    readMessageContext: vi.fn(async () => null),
    searchDocuments: vi.fn(async () => []),
    ...overrides,
  };
}

describe("profile-scoped memory retrieval", () => {
  it("normalizes lexical search and never asks for an embedding by default", async () => {
    const store = makeStore();
    const embeddingProvider: EmbeddingProvider = { model: "mock", embed: vi.fn() };
    const service = createMemoryRetrievalService({ store, semanticQueryProvider: embeddingProvider });

    await expect(service.searchMessages({ profileId: "profile-a", query: "  old\n decision  ", limit: 99 })).resolves.toEqual([]);
    expect(store.searchMessages).toHaveBeenCalledWith({
      profileId: "profile-a",
      query: "old decision",
      queryEmbedding: null,
      threadId: null,
      from: null,
      to: null,
      limit: 10,
    });
    expect(embeddingProvider.embed).not.toHaveBeenCalled();
  });

  it("keeps the optional semantic path injected and bounded", async () => {
    const store = makeStore();
    const vector = Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => 0);
    const embeddingProvider: EmbeddingProvider = { model: "mock", embed: vi.fn(async () => [vector]) };
    const service = createMemoryRetrievalService({ store, semanticSearchEnabled: true, semanticQueryProvider: embeddingProvider });

    await service.searchMessages({
      profileId: "profile-b",
      query: "something",
      threadId,
      from: "2026-08-01T00:00:00+00:00",
      to: "2026-08-02T00:00:00+00:00",
      limit: 2,
    });
    expect(embeddingProvider.embed).toHaveBeenCalledWith(["something"]);
    expect(store.searchMessages).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-b", threadId, limit: 2, queryEmbedding: vector }));
  });

  it("rejects invalid date ranges and malformed exact IDs before the store", async () => {
    const store = makeStore();
    const service = createMemoryRetrievalService({ store });
    await expect(service.searchMessages({ profileId: "profile-a", query: "x", from: "2026-08-02T00:00:00Z", to: "2026-08-01T00:00:00Z" })).rejects.toThrow("before");
    await expect(service.readMessages("profile-a", "foreign-id")).rejects.toThrow("valid UUID");
    expect(store.searchMessages).not.toHaveBeenCalled();
    expect(store.readMessageContext).not.toHaveBeenCalled();
  });

  it("returns unknown and foreign message IDs as the same not-found result", async () => {
    const store = makeStore({ readMessageContext: vi.fn(async () => null) });
    const service = createMemoryRetrievalService({ store });
    await expect(service.readMessages("profile-a", messageId)).resolves.toBeNull();
    await expect(service.readMessages("profile-b", messageId)).resolves.toBeNull();
    expect(store.readMessageContext).toHaveBeenNthCalledWith(1, "profile-a", messageId, 3);
    expect(store.readMessageContext).toHaveBeenNthCalledWith(2, "profile-b", messageId, 3);
  });

  it("keeps canonical document search lexical and profile-scoped", async () => {
    const store = makeStore();
    const service = createMemoryRetrievalService({ store });
    await service.searchMemory("profile-b", "  roadmap ", 2);
    expect(store.searchDocuments).toHaveBeenCalledWith("profile-b", "roadmap", 2);
  });
});
