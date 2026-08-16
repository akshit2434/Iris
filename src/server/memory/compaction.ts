import "server-only";

import { createProductionChatModel, type AgentModel } from "@/server/agent";
import { createTokenEstimator } from "@/server/agent/token-budget";
import { hashMemoryContent } from "@/server/memory/hash";
import { createSupabaseThreadContinuityStore } from "@/server/memory/compaction-repository";
import type {
  ContinuityCheckpointDocument,
  ThreadContinuityCheckpoint,
  ThreadContinuityJob,
  ThreadContinuityMessage,
  ThreadContinuityStore,
} from "@/server/memory/types";

/**
 * Continuity is triggered by the serialized request ledger, never by a count
 * of messages. The normal request assembler owns the safe input budget; this
 * worker only records the same decision and creates a versioned checkpoint.
 */
export const CONTINUITY_TRIGGER_RATIO = 0.75;
export const CONTINUITY_SUMMARIZER_VERSION = "iris-continuity-summarizer-v1";
export const DEFAULT_CONTINUITY_TAIL_TOKENS = 20_000;
const MAX_RENDERED_TEXT = 12_000;
const MAX_FIELD_TEXT = 4_000;
const MAX_LIST_ENTRIES = 24;
const MAX_TOOL_RESULTS = 12;

export type ContinuitySummaryResult = Omit<ContinuityCheckpointDocument, "version" | "source">;

export type ThreadContinuityInput = {
  job: ThreadContinuityJob;
  messages: readonly ThreadContinuityMessage[];
  previousCheckpoint: ThreadContinuityCheckpoint | null;
  rebuildFromRaw: boolean;
};

export type ThreadContinuitySummarizer = {
  summarize: (input: ThreadContinuityInput) => Promise<ContinuitySummaryResult>;
};

export type ContinuityTriggerInput = {
  projectedInputTokens: number;
  safeInputBudgetTokens: number;
  eligibleSourceTokens: number;
  sourceEndMessageId?: string | null;
};

function finiteNonNegative(value: number) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}
/** Background continuity starts near 75%, and only with an older source span. */
export function shouldQueueContinuity(input: ContinuityTriggerInput) {
  const projected = finiteNonNegative(input.projectedInputTokens);
  const safe = finiteNonNegative(input.safeInputBudgetTokens);
  const sourceTokens = finiteNonNegative(input.eligibleSourceTokens);
  return safe > 0
    && projected >= Math.ceil(safe * CONTINUITY_TRIGGER_RATIO)
    && sourceTokens > 0
    && typeof input.sourceEndMessageId === "string"
    && input.sourceEndMessageId.length > 0;
}

/** Synchronous/on-demand work is reserved for the hard safe-cap overflow. */
export function shouldCompactSynchronously(input: ContinuityTriggerInput) {
  const projected = finiteNonNegative(input.projectedInputTokens);
  const safe = finiteNonNegative(input.safeInputBudgetTokens);
  return safe > 0 && projected > safe && finiteNonNegative(input.eligibleSourceTokens) > 0;
}

export function hashContinuityInput(input: {
  threadId: string;
  sourceStartMessageId: string;
  sourceEndMessageId: string;
  sourceMessageIds?: readonly string[];
  sourceEstimatedTokens: number;
  projectedInputTokens: number;
  safeInputBudgetTokens: number;
  model: string;
  tokenizerProvider: string;
  tokenizerVersion: string;
  rebuildFromRaw?: boolean;
}) {
  return hashMemoryContent(JSON.stringify({
    threadId: input.threadId,
    sourceStartMessageId: input.sourceStartMessageId,
    sourceEndMessageId: input.sourceEndMessageId,
    sourceMessageIds: input.sourceMessageIds ?? [],
    sourceEstimatedTokens: finiteNonNegative(input.sourceEstimatedTokens),
    projectedInputTokens: finiteNonNegative(input.projectedInputTokens),
    safeInputBudgetTokens: finiteNonNegative(input.safeInputBudgetTokens),
    model: input.model,
    tokenizerProvider: input.tokenizerProvider,
    tokenizerVersion: input.tokenizerVersion,
    rebuildFromRaw: input.rebuildFromRaw === true,
  }));
}

function normalizeText(value: unknown, maximum = MAX_FIELD_TEXT) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maximum);
}

function normalizeRenderedText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_RENDERED_TEXT);
}

function normalizeList(value: unknown, label: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) throw new Error(`Continuity ${label} is invalid.`);
  return value.map((entry) => {
    const normalized = normalizeText(entry);
    if (!normalized) throw new Error(`Continuity ${label} contains an empty entry.`);
    return normalized;
  });
}

function renderContinuityText(summary: Omit<ContinuityCheckpointDocument, "version" | "source" | "renderedText">) {
  const sections: Array<[string, string | string[] | null]> = [
    ["Goal", summary.threadGoal],
    ["Current state", summary.currentState],
    ["Decisions", summary.decisions],
    ["Constraints", summary.constraints],
    ["Commitments", summary.commitments],
    ["Open questions", summary.openQuestions],
    ["Uncertainties", summary.uncertainties],
    ["Corrections", summary.corrections],
    ["Important tool results", summary.importantToolResults.map((result) => `${result.label}: ${result.result}`)],
  ];
  return sections
    .flatMap(([heading, value]) => {
      if (Array.isArray(value)) return value.length > 0 ? [`## ${heading}`, ...value.map((entry) => `- ${entry}`)] : [];
      return value ? [`## ${heading}`, value] : [];
    })
    .join("\n")
    .slice(0, MAX_RENDERED_TEXT);
}

function validateSourceIds(value: unknown, available: ReadonlySet<string>) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Continuity tool source IDs are invalid.");
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !available.has(entry)) throw new Error("Continuity tool source ID is foreign.");
    return entry;
  });
  return [...new Set(ids)];
}

export function validateContinuitySummary(value: unknown, sourceMessages: readonly ThreadContinuityMessage[] = []): ContinuitySummaryResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Continuity summarizer output was not an object.");
  const candidate = value as Record<string, unknown>;
  const available = new Set(sourceMessages.map((message) => message.messageId));
  const rawToolResults = candidate.importantToolResults ?? [];
  if (!Array.isArray(rawToolResults) || rawToolResults.length > MAX_TOOL_RESULTS) throw new Error("Continuity tool results are invalid.");
  const importantToolResults = rawToolResults.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Continuity tool result is invalid.");
    const record = entry as Record<string, unknown>;
    const label = normalizeText(record.label, 300);
    const result = normalizeText(record.result, MAX_FIELD_TEXT);
    if (!label || !result) throw new Error("Continuity tool result is invalid.");
    return { label, result, sourceMessageIds: validateSourceIds(record.sourceMessageIds, available) };
  });
  const summary = {
    threadGoal: normalizeText(candidate.threadGoal) || null,
    currentState: normalizeText(candidate.currentState) || null,
    decisions: normalizeList(candidate.decisions, "decisions"),
    constraints: normalizeList(candidate.constraints, "constraints"),
    commitments: normalizeList(candidate.commitments, "commitments"),
    openQuestions: normalizeList(candidate.openQuestions, "open questions"),
    uncertainties: normalizeList(candidate.uncertainties, "uncertainties"),
    corrections: normalizeList(candidate.corrections, "corrections"),
    importantToolResults,
  } satisfies Omit<ContinuityCheckpointDocument, "version" | "source" | "renderedText">;
  const suppliedRenderedText = normalizeRenderedText(candidate.renderedText);
  return { ...summary, renderedText: suppliedRenderedText || renderContinuityText(summary) };
}

function parseModelJson(value: unknown) {
  const content = value && typeof value === "object" && "content" in value ? (value as { content?: unknown }).content : value;
  if (typeof content !== "string") return null;
  const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(normalized) as unknown;
  } catch {
    return null;
  }
}

export function createInjectedThreadContinuitySummarizer(producer: (input: ThreadContinuityInput) => Promise<unknown>): ThreadContinuitySummarizer {
  return {
    async summarize(input) {
      return validateContinuitySummary(await producer(input), input.messages);
    },
  };
}

export function createProductionThreadContinuitySummarizer(model: AgentModel = createProductionChatModel()): ThreadContinuitySummarizer {
  return createInjectedThreadContinuitySummarizer(async (input) => {
    const previous = input.rebuildFromRaw || !input.previousCheckpoint
      ? null
      : input.previousCheckpoint.document;
    const prompt = `Return JSON only. Build a compact, factual continuity checkpoint for the supplied ordered source messages.
Required fields: threadGoal (string|null), currentState (string|null), decisions (string[]), constraints (string[]), commitments (string[]), openQuestions (string[]), uncertainties (string[]), corrections (string[]), importantToolResults ({label,result,sourceMessageIds}[]), renderedText (short Markdown).
Preserve unresolved disagreement, corrections, commitments, and important tool results. Never invent facts. Never treat absence as completion. Keep the renderedText concise. Source IDs may only be copied from supplied messages.
${input.rebuildFromRaw ? "Rebuild from raw history. Do not trust any previous checkpoint." : "Update the previous checkpoint only with evidence from the new source messages, while keeping raw provenance."}
<previous-checkpoint>${JSON.stringify(previous)}</previous-checkpoint>
<source-messages>${JSON.stringify(input.messages)}</source-messages>`;
    const response = await model.invoke(prompt, { temperature: 0.1, maxTokens: 2_500 } as never);
    const parsed = parseModelJson(response);
    if (!parsed) throw new Error("Continuity summarizer returned invalid JSON.");
    return parsed;
  });
}

function buildCheckpoint(input: {
  job: ThreadContinuityJob;
  messages: readonly ThreadContinuityMessage[];
  summary: ContinuitySummaryResult;
  previousCheckpoint: ThreadContinuityCheckpoint | null;
}) {
  const estimator = createTokenEstimator({ provider: input.job.tokenizerProvider, model: input.job.model });
  const first = input.messages[0];
  const last = input.messages.at(-1);
  if (!first || !last) throw new Error("Cannot build a continuity checkpoint without source messages.");
  const sourceMessageIds = input.messages.map((message) => message.messageId);
  const sourceEstimatedTokens = input.messages.reduce((sum, message) => {
    const stored = finiteNonNegative(message.estimatedTokens);
    return sum + (stored > 0 ? stored : estimator.estimateMessage({ role: message.role, content: message.content }));
  }, 0);
  const renderedText = input.summary.renderedText || renderContinuityText(input.summary);
  const document: ContinuityCheckpointDocument = {
    version: "iris-continuity-document-v1",
    threadGoal: input.summary.threadGoal,
    currentState: input.summary.currentState,
    decisions: input.summary.decisions,
    constraints: input.summary.constraints,
    commitments: input.summary.commitments,
    openQuestions: input.summary.openQuestions,
    uncertainties: input.summary.uncertainties,
    corrections: input.summary.corrections,
    importantToolResults: input.summary.importantToolResults,
    source: {
      startOrdinal: first.ordinal,
      endOrdinal: last.ordinal,
      startMessageId: first.messageId,
      endMessageId: last.messageId,
      messageIds: sourceMessageIds,
      estimatedTokens: sourceEstimatedTokens,
    },
    renderedText,
  };
  return {
    profileId: input.job.profileId,
    threadId: input.job.threadId,
    document,
    renderedText,
    coveredThroughOrdinal: last.ordinal,
    coveredThroughMessageId: last.messageId,
    coveredThroughCreatedAt: last.createdAt,
    sourceStartMessageId: first.messageId,
    sourceEndMessageId: last.messageId,
    sourceMessageIds,
    sourceEstimatedTokens,
    renderedTokens: estimator.estimateText(renderedText),
    model: input.job.model,
    tokenizerProvider: input.job.tokenizerProvider,
    tokenizerVersion: input.job.tokenizerVersion,
    summarizerVersion: CONTINUITY_SUMMARIZER_VERSION,
    previousCheckpointId: input.previousCheckpoint?.id ?? null,
    inputHash: input.job.inputHash,
  } satisfies Omit<ThreadContinuityCheckpoint, "id" | "createdAt" | "revision">;
}

export type ThreadContinuityWorkerOptions = {
  store: ThreadContinuityStore;
  summarizer: ThreadContinuitySummarizer;
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxDurationMs?: number;
};

export type ThreadContinuityWorkerResult = {
  claimed: number;
  completed: number;
  conflicts: number;
  skipped: number;
  failed: number;
  invalidated: number;
};

function safeContinuityError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /invalid|conflict|foreign|checkpoint|lease|source/i.test(message) ? message.slice(0, 500) : "Continuity checkpoint failed.";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Continuity worker time bound reached.")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export async function processThreadContinuityJobs(options: ThreadContinuityWorkerOptions): Promise<ThreadContinuityWorkerResult> {
  const result: ThreadContinuityWorkerResult = { claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0, invalidated: 0 };
  if (process.env.MEMORY_CONTINUITY_ENABLED !== "true") return result;
  const workerId = (options.workerId ?? `iris-continuity-${crypto.randomUUID()}`).slice(0, 120);
  const maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? 25_000, 60_000));
  const startedAt = Date.now();
  const jobs = await options.store.claimContinuityJobs(workerId, options.limit ?? 1, options.leaseSeconds ?? 120);
  result.claimed = jobs.length;
  for (const job of jobs) {
    try {
      if (Date.now() - startedAt >= maxDurationMs) throw new Error("Continuity worker time bound reached.");
      const messages = await options.store.listContinuityMessages({
        profileId: job.profileId,
        threadId: job.threadId,
        startMessageId: job.sourceStartMessageId,
        endMessageId: job.sourceEndMessageId,
        rebuildFromRaw: job.rebuildFromRaw,
      });
      if (messages.length === 0) {
        await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_SOURCE_MESSAGES", errorMessage: "No complete source messages were available." });
        result.skipped += 1;
        continue;
      }
      const latest = await options.store.readLatestContinuityCheckpoint(job.profileId, job.threadId);
      const previousCheckpoint = job.rebuildFromRaw ? null : latest;
      if (!job.rebuildFromRaw && latest && latest.id !== job.expectedCheckpointId) {
        await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "conflict", errorCode: "STALE_CONTINUITY_SOURCE", errorMessage: "A newer continuity checkpoint already exists." });
        result.conflicts += 1;
        continue;
      }
      const summary = await withTimeout(options.summarizer.summarize({ job, messages, previousCheckpoint, rebuildFromRaw: job.rebuildFromRaw }), Math.max(1_000, maxDurationMs - (Date.now() - startedAt)));
      const checkpoint = buildCheckpoint({ job, messages, summary, previousCheckpoint });
      const status = await options.store.applyContinuityCheckpoint({
        profileId: job.profileId,
        jobId: job.id,
        workerId,
        checkpoint,
        expectedCheckpointId: job.expectedCheckpointId,
        expectedContinuityRevision: job.expectedContinuityRevision,
      });
      if (status === "conflict") {
        await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "conflict", errorCode: "STALE_CONTINUITY_CHECKPOINT", errorMessage: "The continuity source changed while it was being summarized." });
        result.conflicts += 1;
      } else if (status === "invalidated") {
        await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "CHECKPOINT_VERSION_INVALIDATED", errorMessage: "The summarizer version was invalidated; a rebuild is required." });
        result.invalidated += 1;
        result.skipped += 1;
      } else {
        await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "completed" });
        result.completed += 1;
      }
    } catch (error) {
      // The request assembler already retains complete recent units and drops
      // only the oldest units on an urgent overflow. A failed background
      // summarization therefore leaves raw history untouched and retryable.
      const retry = job.attempts < 3;
      await options.store.finishContinuityJob({ profileId: job.profileId, jobId: job.id, workerId, status: "failed", errorCode: "CONTINUITY_FAILED", errorMessage: safeContinuityError(error), retry, availableAt: retry ? new Date(Date.now() + 30_000).toISOString() : null });
      result.failed += 1;
    }
  }
  return result;
}

export async function invalidateContinuityForVersion(input: { store: ThreadContinuityStore; profileId: "profile-a" | "profile-b"; threadId: string; reason: string }) {
  if (input.store.invalidateContinuityCheckpoint) await input.store.invalidateContinuityCheckpoint(input.profileId, input.threadId, input.reason);
}

export function createProductionThreadContinuityWorker(options: Omit<ThreadContinuityWorkerOptions, "store" | "summarizer"> = {}) {
  return processThreadContinuityJobs({ store: createSupabaseThreadContinuityStore(), summarizer: createProductionThreadContinuitySummarizer(), ...options });
}
