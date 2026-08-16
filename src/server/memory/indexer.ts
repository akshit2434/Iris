import "server-only";

import { hashMemoryContent } from "@/server/memory/hash";
import type { EmbeddingProvider } from "@/server/memory/embeddings";
import type { MemoryMessageForIndex, MessageSemanticIndexStore } from "@/server/memory/types";
import { assertMemoryProfileId, validateEmbedding } from "@/server/memory/validation";

export type IndexMessagesResult = {
  indexed: string[];
  skipped: string[];
};

/**
 * Idempotently refreshes derived embeddings. Raw message content is supplied by
 * the caller and never copied into the derived index; only its hash is stored.
 */
export async function indexMessagesForMemory(input: {
  profileId: MemoryMessageForIndex["profileId"];
  messages: readonly MemoryMessageForIndex[];
  provider: EmbeddingProvider;
  store: MessageSemanticIndexStore;
  now?: () => string;
}): Promise<IndexMessagesResult> {
  assertMemoryProfileId(input.profileId);
  const now = input.now ?? (() => new Date().toISOString());
  const indexed: string[] = [];
  const skipped: string[] = [];
  const pending: Array<{ message: MemoryMessageForIndex; contentHash: string }> = [];

  for (const message of input.messages) {
    if (message.profileId !== input.profileId) throw new Error("Memory indexing profile scope mismatch.");
    const contentHash = hashMemoryContent(message.content);
    const existing = await input.store.getMessageEmbeddingMetadata(input.profileId, message.messageId);
    if (existing && existing.profileId !== input.profileId) throw new Error("Memory index returned a cross-profile result.");
    if (existing && existing.threadId !== message.threadId) throw new Error("Memory index thread ownership mismatch.");
    if (existing?.contentHash === contentHash && existing.embeddingModel === input.provider.model) {
      skipped.push(message.messageId);
    } else {
      pending.push({ message, contentHash });
    }
  }

  if (pending.length === 0) return { indexed, skipped };
  const vectors = await input.provider.embed(pending.map(({ message }) => message.content));
  if (vectors.length !== pending.length) throw new Error("Embedding provider returned an unexpected batch length.");

  for (const [index, pendingMessage] of pending.entries()) {
    const embedding = validateEmbedding(vectors[index] ?? []);
    await input.store.upsertMessageEmbedding({
      messageId: pendingMessage.message.messageId,
      profileId: input.profileId,
      threadId: pendingMessage.message.threadId,
      contentHash: pendingMessage.contentHash,
      embeddingModel: input.provider.model,
      indexedAt: now(),
      embedding,
    });
    indexed.push(pendingMessage.message.messageId);
  }
  return { indexed, skipped };
}
