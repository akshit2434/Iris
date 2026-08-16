import "server-only";

import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { createOpenRouterEmbeddingClient, type EmbeddingProvider } from "@/server/memory/embeddings";
import type { MemoryItemSearchResult, MessageContextWindow, MessageMatchType, MessageSearchResult, MessageSearchRole, MemoryStore } from "@/server/memory/types";
import { normalizeMemoryDate, normalizeMemoryExactPhrase, normalizeMemoryLimit, normalizeMemoryMatchType, normalizeMemoryQuery, normalizeMemoryRoles, validateEmbedding, validateMemoryUuid } from "@/server/memory/validation";
import type { ProfileId } from "@/lib/profiles";

export type MemoryRetrieval = {
  searchMessages: (input: { profileId: ProfileId; query: string; exactPhrase?: string | null; matchType?: MessageMatchType; roles?: readonly MessageSearchRole[] | null; threadId?: string | null; excludeThreadId?: string | null; from?: string | null; to?: string | null; limit?: number }) => Promise<MessageSearchResult[]>;
  readMessages: (profileId: ProfileId, messageId: string, windowSize?: number) => Promise<MessageContextWindow | null>;
  listMemory: (profileId: ProfileId) => Promise<Awaited<ReturnType<MemoryStore["listItems"]>>>;
  currentRevision: (profileId: ProfileId) => Promise<number>;
  readMemory: (profileId: ProfileId, canonicalKey: string) => Promise<Awaited<ReturnType<MemoryStore["getItem"]>>>;
  searchMemory: (profileId: ProfileId, query: string, limit?: number) => Promise<MemoryItemSearchResult[]>;
};

type MemoryRetrievalOptions = { store: MemoryStore; semanticSearchEnabled?: boolean; semanticQueryProvider?: EmbeddingProvider };

export function createMemoryRetrievalService(options: MemoryRetrievalOptions): MemoryRetrieval {
  const semanticEnabled = options.semanticSearchEnabled ?? process.env.MEMORY_SEMANTIC_SEARCH_ENABLED === "true";
  return {
    async searchMessages(input) {
      const query = normalizeMemoryQuery(input.query);
      const exactPhrase = normalizeMemoryExactPhrase(input.exactPhrase);
      const matchType = normalizeMemoryMatchType(input.matchType);
      const roles = normalizeMemoryRoles(input.roles);
      const limit = normalizeMemoryLimit(input.limit);
      const threadId = input.threadId ? validateMemoryUuid(input.threadId, "Thread ID") : null;
      const excludeThreadId = input.excludeThreadId ? validateMemoryUuid(input.excludeThreadId, "Excluded thread ID") : null;
      const from = normalizeMemoryDate(input.from, "Start date");
      const to = normalizeMemoryDate(input.to, "End date");
      if (from && to && from >= to) throw new Error("Start date must be before end date.");
      let queryEmbedding: readonly number[] | null = null;
      const wantsSemantic = matchType === "semantic" || matchType === "hybrid";
      if (wantsSemantic && semanticEnabled && options.semanticQueryProvider) {
        try {
          const vectors = await options.semanticQueryProvider.embed([exactPhrase ?? query]);
          if (vectors.length !== 1) throw new Error("Semantic query provider returned an unexpected result.");
          queryEmbedding = validateEmbedding(vectors[0] ?? []);
        } catch {
          // Semantic search is an optional accelerator. Historical evidence
          // must still work through the lexical index when embeddings fail.
          queryEmbedding = null;
        }
      }
      // The active thread is already in model context. Pull a wider bounded
      // candidate set before removing it so recent echoes cannot crowd older
      // cross-chat evidence out of the result.
      const fetchLimit = excludeThreadId ? Math.min(Math.max(limit * 5, 20), 100) : limit;
      const results = await options.store.searchMessages({ profileId: input.profileId, query, exactPhrase, matchType, roles, queryEmbedding, threadId, from, to, limit: fetchLimit });
      return results.filter((result) => result.threadId !== excludeThreadId).slice(0, limit);
    },
    async readMessages(profileId, messageId, windowSize = 3) {
      validateMemoryUuid(messageId, "Message ID");
      return options.store.readMessageContext(profileId, messageId, normalizeMemoryLimit(windowSize, 3));
    },
    async listMemory(profileId) { return options.store.listItems(profileId); },
    async currentRevision(profileId) { return options.store.getCurrentRevision(profileId); },
    async readMemory(profileId, canonicalKey) { return options.store.getItem(profileId, canonicalKey); },
    async searchMemory(profileId, rawQuery, rawLimit = 5) {
      return options.store.searchItems(profileId, normalizeMemoryQuery(rawQuery), normalizeMemoryLimit(rawLimit));
    },
  };
}

export function createProductionMemoryRetrievalService() {
  const semanticSearchEnabled = process.env.MEMORY_SEMANTIC_SEARCH_ENABLED !== "false"
    && Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return createMemoryRetrievalService({
    store: createSupabaseMemoryStore(),
    semanticSearchEnabled,
    ...(semanticSearchEnabled ? { semanticQueryProvider: createOpenRouterEmbeddingClient() } : {}),
  });
}
