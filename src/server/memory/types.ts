import type { ProfileId } from "@/lib/profiles";

export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

export type MemoryItemCategory =
  | "personal_fact"
  | "preference"
  | "instruction"
  | "project"
  | "goal"
  | "relationship"
  | "active_state"
  | "pattern"
  | "other";
export type MemoryItemValueScope = "single" | "multi";
export type MemoryItemOrigin = "explicit" | "inferred" | "system";
export type MemoryItemStatus = "active" | "superseded" | "archived" | "deleted";
export type MemoryMutationKind = "create" | "update" | "supersede" | "archive" | "restore" | "delete" | "merge";
export type MemorySourceKind = "message" | "thread" | "agent_event" | "manual" | "system";

export type MemoryItem = {
  id: string;
  profileId: ProfileId;
  canonicalKey: string;
  content: string;
  itemRevision: number;
  category: MemoryItemCategory;
  valueScope: MemoryItemValueScope;
  origin: MemoryItemOrigin;
  confidence: number;
  importance: number;
  sensitivity: "normal" | "sensitive" | "highly_sensitive";
  status: MemoryItemStatus;
  validFrom: string | null;
  validUntil: string | null;
  lastConfirmedAt: string | null;
  supersededByItemId: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  deletedAt: string | null;
};

export type MemoryItemListOptions = { includeArchived?: boolean; includeDeleted?: boolean };

export type MemoryItemRevision = {
  id: string;
  profileId: ProfileId;
  itemId: string;
  itemRevision: number;
  profileGlobalRevision: number;
  canonicalKey: string;
  content: string;
  contentHash: string;
  category: MemoryItemCategory;
  valueScope: MemoryItemValueScope;
  origin: MemoryItemOrigin;
  confidence: number;
  importance: number;
  sensitivity: "normal" | "sensitive" | "highly_sensitive";
  status: MemoryItemStatus;
  validFrom: string | null;
  validUntil: string | null;
  lastConfirmedAt: string | null;
  supersededByItemId: string | null;
  mutationKind: MemoryMutationKind;
  idempotencyKey: string | null;
  createdAt: string;
};

export type MemorySource = {
  id: string;
  sourceKind: MemorySourceKind;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  sourceAgentEventId: string | null;
  sourceAgentRunId: string | null;
  sourceExcerpt: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  action?: { type: "open_message"; threadId: string; messageId: string; label: string };
};

export type MemoryItemAudit = {
  item: MemoryItem;
  revisions: Array<MemoryItemRevision & { sources: MemorySource[] }>;
};

export type MemoryRevisionDelta = {
  canonicalKey: string;
  mutationKind: MemoryMutationKind;
  itemRevision: number;
  profileGlobalRevision: number;
  createdAt: string;
  status: MemoryItemStatus;
  content: string;
  excerpt: string;
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

export type ApplyMemoryItemRevisionInput = {
  profileId: ProfileId;
  canonicalKey: string;
  content: string;
  category?: MemoryItemCategory;
  valueScope?: MemoryItemValueScope;
  origin?: MemoryItemOrigin;
  confidence?: number;
  importance?: number;
  sensitivity?: "normal" | "sensitive" | "highly_sensitive";
  status: MemoryItemStatus;
  mutationKind: MemoryMutationKind;
  expectedItemRevision?: number | null;
  provenance?: MemoryProvenanceInput;
  idempotencyKey?: string | null;
  supersededByItemId?: string | null;
};

export type AppliedMemoryItemRevision = {
  profileId: ProfileId;
  itemId: string;
  canonicalKey: string;
  itemRevision: number;
  profileGlobalRevision: number;
  revisionId: string;
  sourceId: string;
  contentHash: string;
};

export type MemorySuppression = {
  id: string;
  profileId: ProfileId;
  canonicalKey: string;
  contentHash: string | null;
  itemId: string | null;
  reason: string;
  createdAt: string;
  liftedAt: string | null;
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
  thread: { id: string; profileId: ProfileId; title: string; createdAt: string; updatedAt: string };
  target: MessageContextItem;
  before: MessageContextItem[];
  after: MessageContextItem[];
};

export type MemoryItemSearchResult = {
  itemId: string;
  profileId: ProfileId;
  canonicalKey: string;
  excerpt: string;
  itemRevision: number;
  updatedAt: string;
  category: MemoryItemCategory;
  status: MemoryItemStatus;
};

export type MessageEmbeddingMetadata = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  contentHash: string;
  embeddingModel: string | null;
  indexedAt: string;
};
export type DerivedMessageEmbedding = MessageEmbeddingMetadata & { embedding: readonly number[] };
export type MemoryMessageForIndex = { messageId: string; profileId: ProfileId; threadId: string; content: string };

export type MemoryStore = {
  listItems: (profileId: ProfileId, options?: MemoryItemListOptions) => Promise<MemoryItem[]>;
  getItem: (profileId: ProfileId, canonicalKey: string, options?: MemoryItemListOptions) => Promise<MemoryItem | null>;
  getCurrentRevision: (profileId: ProfileId) => Promise<number>;
  applyItemRevision: (input: ApplyMemoryItemRevisionInput) => Promise<AppliedMemoryItemRevision>;
  searchMessages: (input: MessageSearchInput) => Promise<MessageSearchResult[]>;
  readMessageContext: (profileId: ProfileId, messageId: string, windowSize?: number) => Promise<MessageContextWindow | null>;
  searchItems: (profileId: ProfileId, query: string, limit?: number, options?: MemoryItemListOptions) => Promise<MemoryItemSearchResult[]>;
  listMemoryChanges?: (profileId: ProfileId, afterRevision: number, throughRevision: number, limit?: number) => Promise<MemoryRevisionDelta[]>;
  getItemAudit?: (profileId: ProfileId, canonicalKey: string) => Promise<MemoryItemAudit | null>;
  isSuppressed?: (profileId: ProfileId, canonicalKey: string, contentHash?: string | null) => Promise<boolean>;
  createSuppression?: (input: { profileId: ProfileId; canonicalKey: string; contentHash?: string | null; itemId?: string | null; reason?: string | null }) => Promise<string>;
  liftSuppression?: (profileId: ProfileId, canonicalKey: string, contentHash?: string | null) => Promise<number>;
  advanceThreadMemoryRevisionSeen?: (profileId: ProfileId, threadId: string, snapshotRevision: number) => Promise<number>;
};

export type MemoryConsolidationJobStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type MemoryMutationProposalStatus = "proposed" | "applied" | "rejected" | "conflict";
export type MemoryConsolidationJob = {
  id: string; profileId: ProfileId; threadId: string; sourceRunId: string; status: MemoryConsolidationJobStatus;
  attempts: number; availableAt: string; leaseExpiresAt: string | null; lockedAt: string | null; lockedBy: string | null;
  lastErrorCode: string | null; lastErrorMessage: string | null; createdAt: string; updatedAt: string; completedAt: string | null;
};
export type MemoryMutationProposal = {
  id: string; profileId: ProfileId; threadId: string; sourceRunId: string; jobId: string; proposalIndex: number;
  idempotencyKey: string; canonicalKey: string; proposedContent: string; category: MemoryItemCategory;
  valueScope: MemoryItemValueScope; origin: MemoryItemOrigin; confidence: number; importance: number;
  sensitivity: "normal" | "sensitive" | "highly_sensitive"; expectedItemRevision: number | null;
  mutationKind: Extract<MemoryMutationKind, "create" | "update" | "supersede" | "merge">; sourceMessageIds: string[];
  rationale: string | null; status: MemoryMutationProposalStatus; reason: string | null; resultRevisionId: string | null;
  createdAt: string; updatedAt: string; appliedAt: string | null;
};
export type MemoryProposalApplyResult = {
  status: "applied" | "conflict" | "rejected"; proposalId: string; itemId: string | null; itemRevision: number | null;
  profileGlobalRevision: number | null; revisionId: string | null; sourceId: string | null; reason: string | null;
};
export type MemoryGovernanceStore = {
  enqueueConsolidationJob: (profileId: ProfileId, threadId: string, sourceRunId: string) => Promise<MemoryConsolidationJob>;
  claimConsolidationJobs: (workerId: string, limit?: number, leaseSeconds?: number) => Promise<MemoryConsolidationJob[]>;
  finishConsolidationJob: (input: { profileId: ProfileId; jobId: string; workerId: string; status: Extract<MemoryConsolidationJobStatus, "completed" | "failed" | "skipped">; errorCode?: string | null; errorMessage?: string | null; retry?: boolean; availableAt?: string | null }) => Promise<MemoryConsolidationJob>;
  listJobMessages: (profileId: ProfileId, threadId: string, sourceRunId: string, limit?: number) => Promise<MemoryMessageForIndex[]>;
  insertMutationProposal: (proposal: Omit<MemoryMutationProposal, "id" | "status" | "reason" | "resultRevisionId" | "createdAt" | "updatedAt" | "appliedAt">) => Promise<MemoryMutationProposal>;
  applyMutationProposal: (profileId: ProfileId, jobId: string, proposalId: string, workerId: string) => Promise<MemoryProposalApplyResult>;
};
export type MessageSemanticIndexStore = {
  getMessageEmbeddingMetadata: (profileId: ProfileId, messageId: string) => Promise<MessageEmbeddingMetadata | null>;
  upsertMessageEmbedding: (input: DerivedMessageEmbedding) => Promise<void>;
};

export type ContinuityCheckpointDocument = {
  version: "iris-continuity-document-v1";
  threadGoal: string | null;
  currentState: string | null;
  decisions: string[];
  constraints: string[];
  commitments: string[];
  openQuestions: string[];
  uncertainties: string[];
  corrections: string[];
  importantToolResults: Array<{
    label: string;
    result: string;
    sourceMessageIds: string[];
  }>;
  source: {
    startOrdinal: number;
    endOrdinal: number;
    startMessageId: string;
    endMessageId: string;
    messageIds: string[];
    estimatedTokens: number;
  };
  renderedText: string;
};

export type ThreadContinuityCheckpoint = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  revision: number;
  document: ContinuityCheckpointDocument;
  renderedText: string;
  coveredThroughOrdinal: number;
  coveredThroughMessageId: string;
  coveredThroughCreatedAt: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceMessageIds: string[];
  sourceEstimatedTokens: number;
  renderedTokens: number;
  model: string;
  tokenizerProvider: string;
  tokenizerVersion: string;
  summarizerVersion: string;
  previousCheckpointId: string | null;
  inputHash: string;
  createdAt: string;
};

export type ThreadContinuityJobStatus = "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";
export type ThreadContinuityJob = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  sourceRunId: string;
  status: ThreadContinuityJobStatus;
  attempts: number;
  idempotencyKey: string;
  expectedCheckpointId: string | null;
  expectedContinuityRevision: number;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceStartOrdinal: number;
  sourceEndOrdinal: number;
  sourceEstimatedTokens: number;
  projectedInputTokens: number;
  safeInputBudgetTokens: number;
  inputHash: string;
  model: string;
  tokenizerProvider: string;
  tokenizerVersion: string;
  rebuildFromRaw: boolean;
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

export type ThreadContinuityMessage = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  ordinal: number;
  estimatedTokens: number;
  isComplete: boolean;
};

export type ThreadContinuityStore = {
  enqueueContinuityJob: (input: {
    profileId: ProfileId;
    threadId: string;
    sourceRunId: string;
    sourceStartMessageId: string;
    sourceEndMessageId: string;
    sourceStartOrdinal: number;
    sourceEndOrdinal: number;
    sourceEstimatedTokens: number;
    projectedInputTokens: number;
    safeInputBudgetTokens: number;
    inputHash: string;
    model: string;
    tokenizerProvider: string;
    tokenizerVersion: string;
    rebuildFromRaw?: boolean;
  }) => Promise<ThreadContinuityJob | null>;
  claimContinuityJobs: (workerId: string, limit?: number, leaseSeconds?: number) => Promise<ThreadContinuityJob[]>;
  listContinuityMessages: (input: { profileId: ProfileId; threadId: string; startMessageId: string; endMessageId: string; rebuildFromRaw?: boolean }) => Promise<ThreadContinuityMessage[]>;
  readLatestContinuityCheckpoint: (profileId: ProfileId, threadId: string) => Promise<ThreadContinuityCheckpoint | null>;
  applyContinuityCheckpoint: (input: { profileId: ProfileId; jobId: string; workerId: string; checkpoint: Omit<ThreadContinuityCheckpoint, "id" | "createdAt" | "revision">; expectedCheckpointId: string | null; expectedContinuityRevision: number }) => Promise<"applied" | "conflict" | "invalidated">;
  invalidateContinuityCheckpoint?: (profileId: ProfileId, threadId: string, reason: string) => Promise<void>;
  finishContinuityJob: (input: { profileId: ProfileId; jobId: string; workerId: string; status: Exclude<ThreadContinuityJobStatus, "pending" | "running">; errorCode?: string | null; errorMessage?: string | null; retry?: boolean; availableAt?: string | null }) => Promise<ThreadContinuityJob>;
};
