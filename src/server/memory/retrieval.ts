import "server-only";

import { createSupabaseMemoryStore } from "@/server/memory/repository";
import type { EmbeddingProvider } from "@/server/memory/embeddings";
import type {
  CanonicalDocumentSearchResult,
  MessageContextWindow,
  MessageSearchResult,
  MemoryStore,
} from "@/server/memory/types";
import {
  normalizeMemoryDate,
  normalizeMemoryLimit,
  normalizeMemoryQuery,
  validateEmbedding,
  validateMemoryUuid,
} from "@/server/memory/validation";
import type { ProfileId } from "@/lib/profiles";

export type MemoryRetrieval = {
  searchMessages: (input: {
    profileId: ProfileId;
    query: string;
    threadId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
  }) => Promise<MessageSearchResult[]>;
  readMessages: (profileId: ProfileId, messageId: string, windowSize?: number) => Promise<MessageContextWindow | null>;
  listMemory: (profileId: ProfileId) => Promise<Awaited<ReturnType<MemoryStore["listDocuments"]>>>;
  currentRevision: (profileId: ProfileId) => Promise<number>;
  readMemory: (profileId: ProfileId, logicalKey: string) => Promise<Awaited<ReturnType<MemoryStore["getDocument"]>>>;
  searchMemory: (profileId: ProfileId, query: string, limit?: number) => Promise<CanonicalDocumentSearchResult[]>;
};

type MemoryRetrievalOptions = {
  store: MemoryStore;
  semanticSearchEnabled?: boolean;
  semanticQueryProvider?: EmbeddingProvider;
};

export function createMemoryRetrievalService(options: MemoryRetrievalOptions): MemoryRetrieval {
  const semanticEnabled = options.semanticSearchEnabled ?? process.env.MEMORY_SEMANTIC_SEARCH_ENABLED === "true";

  return {
    async searchMessages(input) {
      const query = normalizeMemoryQuery(input.query);
      const limit = normalizeMemoryLimit(input.limit);
      const threadId = input.threadId ? validateMemoryUuid(input.threadId, "Thread ID") : null;
      const from = normalizeMemoryDate(input.from, "Start date");
      const to = normalizeMemoryDate(input.to, "End date");
      if (from && to && from >= to) throw new Error("Start date must be before end date.");

      let queryEmbedding: readonly number[] | null = null;
      if (semanticEnabled && options.semanticQueryProvider) {
        const vectors = await options.semanticQueryProvider.embed([query]);
        if (vectors.length !== 1) throw new Error("Semantic query provider returned an unexpected result.");
        queryEmbedding = validateEmbedding(vectors[0] ?? []);
      }
      return options.store.searchMessages({ profileId: input.profileId, query, queryEmbedding, threadId, from, to, limit });
    },

    async readMessages(profileId, messageId, windowSize = 3) {
      validateMemoryUuid(messageId, "Message ID");
      const boundedWindow = normalizeMemoryLimit(windowSize, 3);
      return options.store.readMessageContext(profileId, messageId, boundedWindow);
    },

    async listMemory(profileId) {
      return options.store.listDocuments(profileId);
    },

    async currentRevision(profileId) {
      return options.store.getCurrentRevision(profileId);
    },

    async readMemory(profileId, logicalKey) {
      return options.store.getDocument(profileId, logicalKey);
    },

    async searchMemory(profileId, rawQuery, rawLimit = 5) {
      const query = normalizeMemoryQuery(rawQuery);
      const limit = normalizeMemoryLimit(rawLimit);
      return options.store.searchDocuments(profileId, query, limit);
    },
  };
}

export function createProductionMemoryRetrievalService() {
  return createMemoryRetrievalService({ store: createSupabaseMemoryStore() });
}
