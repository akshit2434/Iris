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

export type MemoryDocumentListOptions = {
  includeArchived?: boolean;
};

export type MemoryRevisionDelta = {
  logicalKey: string;
  mutationKind: CanonicalMutationKind;
  documentRevision: number;
  profileGlobalRevision: number;
  createdAt: string;
  archivedAt: string | null;
  contentMarkdown: string;
  excerpt: string;
};

export type MemoryProvenanceRecord = {
  id: string;
  sourceKind: MemorySourceKind;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceExcerpt: string | null;
  createdAt: string;
  action?: {
    type: "open_message";
    threadId: string;
    messageId: string;
    label: string;
  };
};

export type MemoryDocumentAudit = {
  document: CanonicalMemoryDocument;
  revisions: Array<MemoryDocumentRevision & { provenance: MemoryProvenanceRecord[] }>;
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
  idempotencyKey: string | null;
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
  idempotencyKey?: string | null;
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

export type MessageContextItem = {
  messageId: string;
  threadId: string;
  profileId: ProfileId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
};

export type MessageContextWindow = {
  thread: {
    id: string;
    profileId: ProfileId;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  target: MessageContextItem;
  before: MessageContextItem[];
  after: MessageContextItem[];
};

export type CanonicalDocumentSearchResult = {
  documentId: string;
  profileId: ProfileId;
  logicalKey: string;
  excerpt: string;
  documentRevision: number;
  updatedAt: string;
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
  listDocuments: (profileId: ProfileId, options?: MemoryDocumentListOptions) => Promise<CanonicalMemoryDocument[]>;
  getDocument: (profileId: ProfileId, logicalKey: string, options?: MemoryDocumentListOptions) => Promise<CanonicalMemoryDocument | null>;
  getCurrentRevision: (profileId: ProfileId) => Promise<number>;
  applyDocumentRevision: (input: ApplyMemoryDocumentRevisionInput) => Promise<AppliedMemoryDocumentRevision>;
  searchMessages: (input: MessageSearchInput) => Promise<MessageSearchResult[]>;
  readMessageContext: (profileId: ProfileId, messageId: string, windowSize?: number) => Promise<MessageContextWindow | null>;
  searchDocuments: (profileId: ProfileId, query: string, limit?: number, options?: MemoryDocumentListOptions) => Promise<CanonicalDocumentSearchResult[]>;
  listMemoryChanges?: (profileId: ProfileId, afterRevision: number, throughRevision: number, limit?: number) => Promise<MemoryRevisionDelta[]>;
  getDocumentAudit?: (profileId: ProfileId, logicalKey: string) => Promise<MemoryDocumentAudit | null>;
  advanceThreadMemoryRevisionSeen?: (profileId: ProfileId, threadId: string, snapshotRevision: number) => Promise<number>;
};

export type MemoryConsolidationJobStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type MemoryMutationProposalStatus = "proposed" | "applied" | "rejected" | "conflict";

export type MemoryConsolidationJob = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  sourceRunId: string;
  status: MemoryConsolidationJobStatus;
  attempts: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type MemoryMutationProposal = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  sourceRunId: string;
  jobId: string;
  proposalIndex: number;
  idempotencyKey: string;
  logicalKey: string;
  proposedContentMarkdown: string;
  expectedDocumentRevision: number | null;
  mutationKind: Extract<CanonicalMutationKind, "create" | "update" | "merge">;
  sourceMessageIds: string[];
  rationale: string | null;
  status: MemoryMutationProposalStatus;
  reason: string | null;
  resultRevisionId: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
};

export type MemoryProposalApplyResult = {
  status: "applied" | "conflict" | "rejected";
  proposalId: string;
  documentId: string | null;
  documentRevision: number | null;
  profileGlobalRevision: number | null;
  revisionId: string | null;
  provenanceId: string | null;
  reason: string | null;
};

export type MemoryGovernanceStore = {
  enqueueConsolidationJob: (profileId: ProfileId, threadId: string, sourceRunId: string) => Promise<MemoryConsolidationJob>;
  claimConsolidationJobs: (workerId: string, limit?: number, leaseSeconds?: number) => Promise<MemoryConsolidationJob[]>;
  finishConsolidationJob: (input: {
    profileId: ProfileId;
    jobId: string;
    workerId: string;
    status: Extract<MemoryConsolidationJobStatus, "completed" | "failed" | "skipped">;
    errorCode?: string | null;
    errorMessage?: string | null;
    retry?: boolean;
    availableAt?: string | null;
  }) => Promise<MemoryConsolidationJob>;
  listJobMessages: (profileId: ProfileId, threadId: string, sourceRunId: string, limit?: number) => Promise<MemoryMessageForIndex[]>;
  insertMutationProposal: (proposal: Omit<MemoryMutationProposal, "id" | "status" | "reason" | "resultRevisionId" | "createdAt" | "updatedAt" | "appliedAt">) => Promise<MemoryMutationProposal>;
  applyMutationProposal: (profileId: ProfileId, jobId: string, proposalId: string, workerId: string) => Promise<MemoryProposalApplyResult>;
};

export type MessageSemanticIndexStore = {
  getMessageEmbeddingMetadata: (profileId: ProfileId, messageId: string) => Promise<MessageEmbeddingMetadata | null>;
  upsertMessageEmbedding: (input: DerivedMessageEmbedding) => Promise<void>;
};

export type ThreadCompactionJobStatus = "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";

export type ThreadCompactionJob = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  sourceRunId: string;
  status: ThreadCompactionJobStatus;
  attempts: number;
  idempotencyKey: string;
  expectedCompactedThroughMessageId: string | null;
  expectedContinuityRevision: number;
  checkpointMessageId: string;
  checkpointCreatedAt: string;
  recentTailMessages: number;
  availableAt: string;
  leaseExpiresAt: string | null;
  lockedAt: string | null;
  lockedBy: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type ThreadCompactionStore = {
  enqueueCompactionJob: (profileId: ProfileId, threadId: string, sourceRunId: string, minMessages?: number, recentTailMessages?: number) => Promise<ThreadCompactionJob | null>;
  claimCompactionJobs: (workerId: string, limit?: number, leaseSeconds?: number) => Promise<ThreadCompactionJob[]>;
  listCompactionMessages: (profileId: ProfileId, threadId: string, checkpointMessageId: string, limit?: number) => Promise<ThreadCompactionMessage[]>;
  readCompactionContext?: (profileId: ProfileId, threadId: string) => Promise<{ continuitySummary: string | null; pinnedNotes: string[] }>;
  applyCompactionCheckpoint: (input: { profileId: ProfileId; jobId: string; workerId: string; summary: string; pinnedNotes: string[]; checkpointMessageId: string; checkpointCreatedAt: string }) => Promise<"applied" | "conflict">;
  finishCompactionJob: (input: { profileId: ProfileId; jobId: string; workerId: string; status: Exclude<ThreadCompactionJobStatus, "pending" | "running">; errorCode?: string | null; errorMessage?: string | null; retry?: boolean; availableAt?: string | null }) => Promise<ThreadCompactionJob>;
};

export type ThreadCompactionMessage = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
};
