import { describe, expect, it, vi } from "vitest";
import { indexMessagesForMemory } from "@/server/memory/indexer";
import { MEMORY_EMBEDDING_DIMENSIONS, type DerivedMessageEmbedding, type MemoryMessageForIndex, type MessageEmbeddingMetadata, type MessageSemanticIndexStore } from "@/server/memory/types";
import type { EmbeddingProvider } from "@/server/memory/embeddings";

const embedding = (seed: number) => Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, () => seed);
const message = (content: string, overrides: Partial<MemoryMessageForIndex> = {}): MemoryMessageForIndex => ({
  messageId: overrides.messageId ?? `message-${content}`,
  profileId: overrides.profileId ?? "profile-a",
  threadId: overrides.threadId ?? "thread-a",
  content,
});

function fakeStore(initial: MessageEmbeddingMetadata[] = []) {
  const records = new Map(initial.map((item) => [item.messageId, item]));
  const upserts: DerivedMessageEmbedding[] = [];
  const store: MessageSemanticIndexStore = {
    getMessageEmbeddingMetadata: vi.fn(async (_profileId, messageId) => records.get(messageId) ?? null),
    upsertMessageEmbedding: vi.fn(async (input) => {
      upserts.push(input);
      records.set(input.messageId, {
        messageId: input.messageId,
        profileId: input.profileId,
        threadId: input.threadId,
        contentHash: input.contentHash,
        embeddingModel: input.embeddingModel,
        indexedAt: input.indexedAt,
      });
    }),
  };
  return { store, upserts };
}

describe("derived message indexing", () => {
  it("batches changed messages, skips unchanged same-model rows, and is replay-safe", async () => {
    const { store, upserts } = fakeStore();
    const embed = vi.fn(async (inputs: readonly string[]) => inputs.map((_, index) => embedding(index + 1)));
    const provider: EmbeddingProvider = { model: "mock-embedding-v1", embed };
    const messages = [message("one", { messageId: "one" }), message("two", { messageId: "two" })];

    await expect(indexMessagesForMemory({ profileId: "profile-a", messages, provider, store, now: () => "2026-08-16T00:00:00.000Z" })).resolves.toEqual({ indexed: ["one", "two"], skipped: [] });
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed).toHaveBeenCalledWith(["one", "two"]);
    expect(upserts).toHaveLength(2);

    await expect(indexMessagesForMemory({ profileId: "profile-a", messages, provider, store })).resolves.toEqual({ indexed: [], skipped: ["one", "two"] });
    expect(embed).toHaveBeenCalledTimes(1);

    const changed = message("one changed", { messageId: "one" });
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [changed], provider, store })).resolves.toEqual({ indexed: ["one"], skipped: [] });
    expect(embed).toHaveBeenCalledTimes(2);

    const newModel: EmbeddingProvider = { model: "mock-embedding-v2", embed };
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [changed], provider: newModel, store })).resolves.toEqual({ indexed: ["one"], skipped: [] });
  });

  it("rejects profile and existing thread ownership mismatches before writing", async () => {
    const { store, upserts } = fakeStore([{ messageId: "known", profileId: "profile-a", threadId: "thread-other", contentHash: "0".repeat(64), embeddingModel: "old", indexedAt: "now" }]);
    const provider: EmbeddingProvider = { model: "mock", embed: vi.fn(async () => [embedding(1)]) };
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [message("x", { profileId: "profile-b" })], provider, store })).rejects.toThrow("profile scope mismatch");
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [message("x", { messageId: "known", threadId: "thread-a" })], provider, store })).rejects.toThrow("thread ownership mismatch");
    expect(upserts).toHaveLength(0);
  });

  it("does not call the provider for an empty batch and validates returned dimensions", async () => {
    const { store } = fakeStore();
    const embed = vi.fn(async () => []);
    const provider: EmbeddingProvider = { model: "mock", embed };
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [], provider, store })).resolves.toEqual({ indexed: [], skipped: [] });
    expect(embed).not.toHaveBeenCalled();

    const badProvider: EmbeddingProvider = { model: "bad", embed: vi.fn(async () => [[1]]) };
    await expect(indexMessagesForMemory({ profileId: "profile-a", messages: [message("bad")], provider: badProvider, store })).rejects.toThrow("exactly 1536");
  });
});
