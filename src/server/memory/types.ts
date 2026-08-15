import type { ProfileId } from "@/lib/profiles";

export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export type CanonicalMutationKind = "create" | "update" | "archive" | "restore" | "merge";
export type MemorySourceKind = "message" | "thread" | "agent_event" | "manual" | "system";

export type CanonicalMemoryDocument = {
  id: string;
  profileId: ProfileId;
  logicalKey: string;
  contentMarkdown: string;
  documentRevision: number;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type MemoryDocumentRevision = {
  id: string;
  profileId: ProfileId;
  documentId: string;
  documentRevision: number;
  profileGlobalRevision: number;
  contentMarkdown: string;
  contentHash: string;
  mutationKind: CanonicalMutationKind;
  createdAt: string;
};

export type MemoryProvenanceInput = {
  sourceKind: MemorySourceKind;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  sourceAgentEventId?: string | null;
  sourceAgentRunId?: string | null;
  sourceExcerpt?: string | null;
  metadata?: Record<string, unknown>;
};

export type ApplyMemoryDocumentRevisionInput = {
  profileId: ProfileId;
  logicalKey: string;
  contentMarkdown: string;
  mutationKind: CanonicalMutationKind;
  expectedDocumentRevision?: number | null;
  provenance?: MemoryProvenanceInput;
};

export type AppliedMemoryDocumentRevision = {
  profileId: ProfileId;
  documentId: string;
  documentRevision: number;
  profileGlobalRevision: number;
  revisionId: string;
  provenanceId: string;
};

export type MessageSearchInput = {
  profileId: ProfileId;
  query: string;
  queryEmbedding?: readonly number[] | null;
  threadId?: string | null;
  from?: string | null;
  to?: string | null;
  limit?: number;
};

export type MessageSearchResult = {
  messageId: string;
  threadId: string;
  profileId: ProfileId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  lexicalScore: number;
  semanticScore: number | null;
  combinedScore: number;
};

export type MessageEmbeddingMetadata = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  contentHash: string;
  embeddingModel: string | null;
  indexedAt: string;
};

export type DerivedMessageEmbedding = MessageEmbeddingMetadata & {
  embedding: readonly number[];
};

export type MemoryMessageForIndex = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  content: string;
};

export type MemoryStore = {
  listDocuments: (profileId: ProfileId) => Promise<CanonicalMemoryDocument[]>;
  getDocument: (profileId: ProfileId, logicalKey: string) => Promise<CanonicalMemoryDocument | null>;
  getCurrentRevision: (profileId: ProfileId) => Promise<number>;
  applyDocumentRevision: (input: ApplyMemoryDocumentRevisionInput) => Promise<AppliedMemoryDocumentRevision>;
  searchMessages: (input: MessageSearchInput) => Promise<MessageSearchResult[]>;
};

export type MessageSemanticIndexStore = {
  getMessageEmbeddingMetadata: (profileId: ProfileId, messageId: string) => Promise<MessageEmbeddingMetadata | null>;
  upsertMessageEmbedding: (input: DerivedMessageEmbedding) => Promise<void>;
};
