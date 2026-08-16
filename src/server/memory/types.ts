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
/**
 * The relationship between a source event and the memory revision it
 * supports.  This is kept in source metadata so the source rows remain
 * backwards compatible with the foundation migration while still exposing a
 * typed provenance contract to the runtime and UI.
 */
export type MemoryProvenanceRelation = "supports" | "corrects" | "supersedes" | "contradicts" | "derived";

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
  relation: MemoryProvenanceRelation;
  createdAt: string;
  action?: { type: "open_message"; threadId: string; messageId: string; label: string };
};

export type MemoryControls = {
  profileId: ProfileId;
  savedMemoryEnabled: boolean;
  referenceHistoryEnabled: boolean;
  updatedAt: string;
};

export type ReferenceHistoryStatus = "active" | "superseded" | "invalidated";

export type ReferenceHistorySourceRange = {
  threadId: string;
  startMessageId: string;
  endMessageId: string;
  startAt: string;
  endAt: string;
  estimatedTokens: number;
};

/** Exact source span supporting one derived claim. */
export type ReferenceHistoryClaimSourceRange = ReferenceHistorySourceRange;

export type ReferenceHistoryClaim = {
  text: string;
  confidence: number;
  temporalQualifier: string | null;
  /** Optional plain-language uncertainty note from the synthesizer. */
  uncertainty?: string | null;
  sourceMessageIds: string[];
  /** Derived from sourceMessageIds when the model only returns message IDs. */
  sourceRanges?: ReferenceHistoryClaimSourceRange[];
  memoryKeys: string[];
  /** True when the claim is retained for provenance but no longer current. */
  stale?: boolean;
  /** Current saved-memory wording for a stale keyed claim. */
  memoryOverlay?: string | null;
};

export type ReferenceHistoryDocument = {
  version: "iris-reference-history-v1";
  ongoingWork: ReferenceHistoryClaim[];
  recurringPreferences: ReferenceHistoryClaim[];
  relationshipsContext: ReferenceHistoryClaim[];
  recentChanges: ReferenceHistoryClaim[];
  boundedPatterns: ReferenceHistoryClaim[];
  renderedText: string;
};

export type ReferenceHistorySnapshot = {
  id: string;
  profileId: ProfileId;
  revision: number;
  status: ReferenceHistoryStatus;
  document: ReferenceHistoryDocument;
  renderedText: string;
  sourceRanges: ReferenceHistorySourceRange[];
  coveredTokenWatermark: number;
  coveredThroughAt: string | null;
  sourceHash: string;
  memoryRevision: number;
  model: string;
  synthesizerVersion: string;
  previousSnapshotId: string | null;
  createdAt: string;
};

export type ReferenceHistoryJobStatus = "pending" | "running" | "completed" | "failed" | "conflict" | "skipped";

export type ReferenceHistoryJob = {
  id: string;
  profileId: ProfileId;
  sourceRunId: string | null;
  status: ReferenceHistoryJobStatus;
  attempts: number;
  idempotencyKey: string;
  expectedSnapshotId: string | null;
  expectedSnapshotRevision: number;
  sourceStartTokenWatermark: number;
  sourceEndTokenWatermark: number;
  rebuildFromRaw: boolean;
  idleSignal: boolean;
  model: string;
  synthesizerVersion: string;
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

export type ReferenceHistoryMessage = {
  messageId: string;
  profileId: ProfileId;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: string;
  estimatedTokens: number;
  tokenStart: number;
  tokenEnd: number;
};

export type ReferenceHistoryStore = {
  getControls: (profileId: ProfileId) => Promise<MemoryControls>;
  updateControls?: (input: { profileId: ProfileId; savedMemoryEnabled?: boolean; referenceHistoryEnabled?: boolean }) => Promise<MemoryControls>;
  getLatestSnapshot: (profileId: ProfileId) => Promise<ReferenceHistorySnapshot | null>;
  listSourceMessages: (input: { profileId: ProfileId; afterTokenWatermark: number; rebuildFromRaw?: boolean }) => Promise<ReferenceHistoryMessage[]>;
  enqueueReferenceHistoryJob: (input: { profileId: ProfileId; sourceRunId?: string | null; sourceTokenTotal?: number; idleSignal?: boolean; rebuildFromRaw?: boolean; model?: string; synthesizerVersion?: string; debounceSeconds?: number }) => Promise<ReferenceHistoryJob | null>;
  claimReferenceHistoryJobs: (workerId: string, limit?: number, leaseSeconds?: number) => Promise<ReferenceHistoryJob[]>;
  applyReferenceHistorySnapshot: (input: { profileId: ProfileId; jobId: string; workerId: string; snapshot: Omit<ReferenceHistorySnapshot, "id" | "createdAt" | "revision" | "status">; expectedSnapshotId: string | null; expectedSnapshotRevision: number }) => Promise<"applied" | "conflict" | "invalidated">;
  finishReferenceHistoryJob: (input: { profileId: ProfileId; jobId: string; workerId: string; status: Exclude<ReferenceHistoryJobStatus, "pending" | "running">; errorCode?: string | null; errorMessage?: string | null; retry?: boolean; availableAt?: string | null }) => Promise<ReferenceHistoryJob>;
  invalidateReferenceHistorySnapshot?: (profileId: ProfileId, reason: string) => Promise<void>;
  clearReferenceHistoryData?: (profileId: ProfileId) => Promise<void>;
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
  relation?: MemoryProvenanceRelation;
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

/** Search strategy used by the historical-message index. */
export type MessageMatchType = "exact_phrase" | "hybrid" | "semantic";
export type MessageSearchRole = "user" | "assistant" | "tool";

export type MessageSearchInput = {
  profileId: ProfileId;
  query: string;
  queryEmbedding?: readonly number[] | null;
  exactPhrase?: string | null;
  matchType?: MessageMatchType;
  roles?: readonly MessageSearchRole[] | null;
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
  matchType?: MessageMatchType;
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
  listActiveSuppressions?: (profileId: ProfileId) => Promise<MemorySuppression[]>;
  isSuppressed?: (profileId: ProfileId, canonicalKey: string, contentHash?: string | null) => Promise<boolean>;
  createSuppression?: (input: { profileId: ProfileId; canonicalKey: string; contentHash?: string | null; itemId?: string | null; reason?: string | null }) => Promise<string>;
  liftSuppression?: (profileId: ProfileId, canonicalKey: string, contentHash?: string | null) => Promise<number>;
  advanceThreadMemoryRevisionSeen?: (profileId: ProfileId, threadId: string, snapshotRevision: number) => Promise<number>;
};

export type MemoryConsolidationJobStatus = "pending" | "running" | "completed" | "failed" | "skipped";
export type MemoryMutationProposalStatus = "proposed" | "applied" | "rejected" | "conflict";
export type MemoryConsolidationJob = {
  id: string; profileId: ProfileId; threadId: string; sourceRunId: string; status: MemoryConsolidationJobStatus;
  sourceTokenTotal: number;
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
  enqueueConsolidationJob: (profileId: ProfileId, threadId: string, sourceRunId: string, options?: {
    sourceTokenTotal?: number;
    idleSignal?: boolean;
    debounceSeconds?: number;
  }) => Promise<MemoryConsolidationJob | null>;
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
