import "server-only";

import { createProductionChatModel, type AgentModel } from "@/server/agent";
import { hashMemoryContent } from "@/server/memory/hash";
import { createSupabaseReferenceHistoryStore } from "@/server/memory/reference-history-repository";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import { validateConsolidationProposals, type ConsolidationProposalInput } from "@/server/memory/consolidation";
import type {
  MemoryItem,
  MemorySuppression,
  MemoryStore,
  ReferenceHistoryClaim,
  ReferenceHistoryDocument,
  ReferenceHistoryJob,
  ReferenceHistoryMessage,
  ReferenceHistorySnapshot,
  ReferenceHistorySourceRange,
  ReferenceHistoryStore,
} from "@/server/memory/types";
import { validateCanonicalKey, validateMemoryContentSafety, validateMemoryUuid } from "@/server/memory/validation";

export const REFERENCE_HISTORY_TRIGGER_TOKENS = 2_400;
export const REFERENCE_HISTORY_IDLE_DEBOUNCE_MS = 30_000;
export const REFERENCE_HISTORY_SYNTHESIZER_VERSION = "iris-reference-history-v1";
const MAX_CLAIMS_PER_SECTION = 16;
const MAX_SOURCE_IDS_PER_CLAIM = 12;
const MAX_TEXT_PER_CLAIM = 1_200;
const MAX_RENDERED_TEXT = 16_000;
const MAX_SOURCE_RANGES = 200;

type ReferenceHistorySections = Exclude<keyof ReferenceHistoryDocument, "version" | "renderedText">;

export type ReferenceHistorySynthesisInput = {
  job: ReferenceHistoryJob;
  messages: readonly ReferenceHistoryMessage[];
  previousSnapshot: ReferenceHistorySnapshot | null;
  savedItems: readonly MemoryItem[];
  suppressions: readonly MemorySuppression[];
};

export type ReferenceHistorySynthesisResult = {
  document: ReferenceHistoryDocument;
  memoryCandidates: ConsolidationProposalInput[];
};

export type ReferenceHistorySynthesizer = {
  synthesize: (input: ReferenceHistorySynthesisInput) => Promise<ReferenceHistorySynthesisResult>;
};

export type ReferenceHistoryWorkerOptions = {
  store: ReferenceHistoryStore;
  memoryStore: MemoryStore;
  synthesizer: ReferenceHistorySynthesizer;
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxDurationMs?: number;
  onValidatedMemoryCandidates?: (input: { profileId: ReferenceHistoryJob["profileId"]; job: ReferenceHistoryJob; candidates: ConsolidationProposalInput[] }) => Promise<void>;
};

export type ReferenceHistoryWorkerResult = {
  claimed: number;
  completed: number;
  conflicts: number;
  skipped: number;
  failed: number;
  invalidated: number;
};

function finiteNonNegative(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Cheap request-side preflight. The enqueue RPC repeats this atomically. */
export function shouldQueueReferenceHistory(input: {
  runStatus: "completed" | "failed";
  assistantPersisted: boolean;
  sourceTokenTotal: number;
  lastProcessedTokenWatermark: number;
  idleSignal?: boolean;
  rebuildFromRaw?: boolean;
}) {
  if (input.runStatus !== "completed" || !input.assistantPersisted) return false;
  if (input.rebuildFromRaw === true) return true;
  const source = finiteNonNegative(input.sourceTokenTotal);
  const processed = finiteNonNegative(input.lastProcessedTokenWatermark);
  if (source <= processed) return false;
  return input.idleSignal === true || source - processed >= REFERENCE_HISTORY_TRIGGER_TOKENS;
}

function compactText(value: unknown, maximum = MAX_TEXT_PER_CLAIM) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, maximum) : "";
}

function normalizeTemporalQualifier(value: unknown) {
  const normalized = compactText(value, 240);
  return normalized || null;
}

function normalizeSourceIds(value: unknown, available: ReadonlySet<string>) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SOURCE_IDS_PER_CLAIM) {
    throw new Error("Reference history claim source IDs are invalid.");
  }
  const ids = value.map((entry) => {
    if (typeof entry !== "string" || !available.has(entry)) throw new Error("Reference history claim source ID is foreign.");
    validateMemoryUuid(entry, "Reference history source message ID");
    return entry;
  });
  return [...new Set(ids)];
}

function normalizeMemoryKeys(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("Reference history memory keys are invalid.");
  return [...new Set(value.map((entry) => {
    if (typeof entry !== "string") throw new Error("Reference history memory key is invalid.");
    return validateCanonicalKey(entry);
  }))];
}

function normalizeClaim(value: unknown, available: ReadonlySet<string>): ReferenceHistoryClaim | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reference history claim is invalid.");
  const record = value as Record<string, unknown>;
  const text = compactText(record.text);
  if (!text) return null;
  let safeText = text;
  try {
    safeText = validateMemoryContentSafety(text);
    if (/\b(?:password|api[ _-]?key|access[ _-]?token|private[ _-]?key|client[ _-]?secret|secret)\b\s*(?:is|=|:)\s*\S+/i.test(text)) {
      return null;
    }
    if (/\b(?:adhd|autis(?:m|tic)|bipolar|depress(?:ed|ion)|anxious|narcissist|psychopath|sociopath|personality disorder|mental illness|risk label)\b/i.test(text)
      && /\b(?:maybe|might|possibly|could|perhaps|seems?|suspect|appears?)\b/i.test(text)) {
      return null;
    }
  } catch {
    // Unsafe claims are dropped, not retried. They are not suitable for a
    // derived profile layer and must never block a clean snapshot.
    return null;
  }
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Math.max(0, Math.min(1, record.confidence))
    : 0.5;
  return {
    text: safeText,
    confidence,
    temporalQualifier: normalizeTemporalQualifier(record.temporalQualifier),
    sourceMessageIds: normalizeSourceIds(record.sourceMessageIds, available),
    memoryKeys: normalizeMemoryKeys(record.memoryKeys),
  };
}

function renderClaim(claim: ReferenceHistoryClaim) {
  return `- ${claim.text}${claim.temporalQualifier ? ` (${claim.temporalQualifier})` : ""}`;
}

export function renderReferenceHistoryText(document: Omit<ReferenceHistoryDocument, "version" | "renderedText">) {
  const sections: Array<[string, ReferenceHistoryClaim[]]> = [
    ["Ongoing work", document.ongoingWork],
    ["Recurring preferences", document.recurringPreferences],
    ["Relationships and context", document.relationshipsContext],
    ["Recent changes", document.recentChanges],
    ["Bounded patterns", document.boundedPatterns],
  ];
  return sections.flatMap(([heading, claims]) => claims.length > 0 ? [`## ${heading}`, ...claims.map(renderClaim)] : []).join("\n").slice(0, MAX_RENDERED_TEXT);
}

export function validateReferenceHistoryDocument(value: unknown, sourceMessages: readonly ReferenceHistoryMessage[] = []): ReferenceHistoryDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Reference history synthesizer output was not an object.");
  const record = value as Record<string, unknown>;
  const available = new Set(sourceMessages.map((message) => message.messageId));
  const sections = {} as Record<ReferenceHistorySections, ReferenceHistoryClaim[]>;
  for (const section of ["ongoingWork", "recurringPreferences", "relationshipsContext", "recentChanges", "boundedPatterns"] as const) {
    const raw = record[section] ?? [];
    if (!Array.isArray(raw) || raw.length > MAX_CLAIMS_PER_SECTION) throw new Error(`Reference history ${section} is invalid.`);
    sections[section] = raw.map((entry) => normalizeClaim(entry, available)).filter((entry): entry is ReferenceHistoryClaim => entry !== null);
  }
  const base = { ...sections };
  const suppliedRendered = compactText(record.renderedText, MAX_RENDERED_TEXT);
  return {
    version: "iris-reference-history-v1",
    ...base,
    renderedText: suppliedRendered || renderReferenceHistoryText(base),
  };
}

function claimMentionsSuppression(claim: ReferenceHistoryClaim, suppression: MemorySuppression) {
  if (claim.memoryKeys.includes(suppression.canonicalKey)) return true;
  return Boolean(suppression.contentHash && hashMemoryContent(claim.text) === suppression.contentHash);
}

/** Apply current saved-memory constraints at read time as a second hard gate. */
export function applyReferenceHistoryConstraints(
  document: ReferenceHistoryDocument,
  input: { savedItems?: readonly MemoryItem[]; suppressions?: readonly MemorySuppression[]; changedMemoryRevision?: boolean } = {},
): ReferenceHistoryDocument {
  const suppressions = input.suppressions ?? [];
  const activeKeys = new Set((input.savedItems ?? []).filter((item) => item.status === "active").map((item) => item.canonicalKey));
  const filter = (claims: readonly ReferenceHistoryClaim[]) => claims.filter((claim) => {
    if (suppressions.some((suppression) => claimMentionsSuppression(claim, suppression))) return false;
    // A correction may supersede the wording behind a keyed claim. Do not
    // carry the old derived wording across that memory revision; the next
    // synthesis can reintroduce a fresh claim from current evidence.
    if (input.changedMemoryRevision === true && claim.memoryKeys.length > 0) return false;
    // A key no longer represented by active saved memory is not allowed to
    // keep an old canonical fact alive inside a derived synthesis.
    if (claim.memoryKeys.some((key) => !activeKeys.has(key)) && claim.memoryKeys.length > 0) return false;
    return true;
  });
  const constrained = {
    ongoingWork: filter(document.ongoingWork),
    recurringPreferences: filter(document.recurringPreferences),
    relationshipsContext: filter(document.relationshipsContext),
    recentChanges: filter(document.recentChanges),
    boundedPatterns: filter(document.boundedPatterns),
  };
  return { version: "iris-reference-history-v1", ...constrained, renderedText: renderReferenceHistoryText(constrained) };
}

export function formatReferenceHistoryPrompt(
  snapshot: ReferenceHistorySnapshot,
  input: { savedItems?: readonly MemoryItem[]; suppressions?: readonly MemorySuppression[] } = {},
) {
  const document = applyReferenceHistoryConstraints(snapshot.document, input);
  if (!document.renderedText) return "";
  const escaped = document.renderedText.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;");
  return `snapshot-revision=${snapshot.revision}; covered-token-watermark=${snapshot.coveredTokenWatermark}; source-hash=${snapshot.sourceHash}\n${escaped}`;
}

function sourceRanges(messages: readonly ReferenceHistoryMessage[]): ReferenceHistorySourceRange[] {
  const ranges = new Map<string, ReferenceHistorySourceRange>();
  for (const message of messages) {
    const current = ranges.get(message.threadId);
    if (!current) {
      ranges.set(message.threadId, {
        threadId: message.threadId,
        startMessageId: message.messageId,
        endMessageId: message.messageId,
        startAt: message.createdAt,
        endAt: message.createdAt,
        estimatedTokens: message.estimatedTokens,
      });
    } else {
      current.endMessageId = message.messageId;
      current.endAt = message.createdAt;
      current.estimatedTokens += message.estimatedTokens;
    }
  }
  return [...ranges.values()].slice(0, MAX_SOURCE_RANGES);
}

function mergeSourceRanges(previous: readonly ReferenceHistorySourceRange[], next: readonly ReferenceHistorySourceRange[]) {
  const merged = new Map<string, ReferenceHistorySourceRange>();
  for (const range of previous) merged.set(range.threadId, { ...range });
  for (const range of next) {
    const current = merged.get(range.threadId);
    if (!current) {
      merged.set(range.threadId, { ...range });
      continue;
    }
    current.endMessageId = range.endMessageId;
    current.endAt = range.endAt;
    current.estimatedTokens += range.estimatedTokens;
  }
  return [...merged.values()].slice(0, MAX_SOURCE_RANGES);
}

export function hashReferenceHistoryInput(input: {
  profileId: string;
  messages: readonly ReferenceHistoryMessage[];
  previousSnapshot: ReferenceHistorySnapshot | null;
  savedItems: readonly MemoryItem[];
  suppressions: readonly MemorySuppression[];
  synthesizerVersion: string;
}) {
  return hashMemoryContent(JSON.stringify({
    profileId: input.profileId,
    previousSnapshotHash: input.previousSnapshot?.sourceHash ?? null,
    previousSnapshotRevision: input.previousSnapshot?.revision ?? 0,
    synthesizerVersion: input.synthesizerVersion,
    savedItems: input.savedItems.filter((item) => item.status === "active").map((item) => ({ key: item.canonicalKey, content: item.content, revision: item.itemRevision })),
    suppressions: input.suppressions.map((suppression) => ({ key: suppression.canonicalKey, contentHash: suppression.contentHash })),
    messages: input.messages.map((message) => ({ id: message.messageId, threadId: message.threadId, role: message.role, content: message.content, createdAt: message.createdAt, estimatedTokens: message.estimatedTokens, tokenEnd: message.tokenEnd })),
  }));
}

function parseModelJson(value: unknown) {
  const content = value && typeof value === "object" && "content" in value ? (value as { content?: unknown }).content : value;
  if (typeof content !== "string") return null;
  const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(normalized) as unknown; } catch { return null; }
}

export function createInjectedReferenceHistorySynthesizer(producer: (input: ReferenceHistorySynthesisInput) => Promise<unknown>): ReferenceHistorySynthesizer {
  return {
    async synthesize(input) {
      const raw = await producer(input);
      const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
      const documentValue = record.document && typeof record.document === "object" ? record.document : raw;
      const memoryCandidates = Array.isArray(record.memoryCandidates) ? record.memoryCandidates as ConsolidationProposalInput[] : [];
      return { document: validateReferenceHistoryDocument(documentValue, input.messages), memoryCandidates };
    },
  };
}

export function createProductionReferenceHistorySynthesizer(model: AgentModel = createProductionChatModel()): ReferenceHistorySynthesizer {
  return createInjectedReferenceHistorySynthesizer(async (input) => {
    const previous = input.job.rebuildFromRaw ? null : input.previousSnapshot?.document ?? null;
    const prompt = `Return JSON only for a derived, rebuildable profile reference-history snapshot.
Required shape: document={ongoingWork, recurringPreferences, relationshipsContext, recentChanges, boundedPatterns (arrays of {text, confidence, temporalQualifier, sourceMessageIds, memoryKeys}), renderedText} and memoryCandidates (array; usually empty). Memory candidates are only proposals and are never authoritative writes.
Use only supplied source message IDs. Preserve uncertainty and temporal qualifiers. Keep claims concise. Cover ongoing work, recurring preferences, relationship/context facts, meaningful changes, and repeated patterns only when evidence supports them. Do not convert absence into completion. Do not invent facts. Do not store passwords, API keys, one-time codes, transient location or mood, role-play, sensitive third-party data, speculative diagnoses, personality labels, or risk labels. A saved-memory correction or suppression is a hard constraint: never reintroduce a suppressed or superseded fact. Use memoryKeys only for supplied active saved-memory keys. This is not authoritative saved memory; it is derived context. It may include no durable-memory proposal.
${input.job.rebuildFromRaw ? "Rebuild from all supplied raw evidence; ignore the previous snapshot." : "Update the previous snapshot with the new evidence while retaining still-supported context."}
<previous-snapshot>${JSON.stringify(previous)}</previous-snapshot>
<active-saved-memory>${JSON.stringify(input.savedItems.filter((item) => item.status === "active").map((item) => ({ canonicalKey: item.canonicalKey, content: item.content, itemRevision: item.itemRevision })))}</active-saved-memory>
<suppressed-memory>${JSON.stringify(input.suppressions.map((suppression) => ({ canonicalKey: suppression.canonicalKey, contentHash: suppression.contentHash, reason: suppression.reason })))}</suppressed-memory>
<new-raw-evidence>${JSON.stringify(input.messages.map((message) => ({ messageId: message.messageId, threadId: message.threadId, role: message.role, content: message.content, createdAt: message.createdAt })))}</new-raw-evidence>`;
    const response = await model.invoke(prompt, { temperature: 0.1, maxTokens: 4_000 } as never);
    const parsed = parseModelJson(response);
    if (!parsed) throw new Error("Reference history synthesizer returned invalid JSON.");
    return parsed;
  });
}

function validateReferenceHistoryCandidates(input: ReferenceHistorySynthesisInput, candidates: readonly ConsolidationProposalInput[]) {
  if (candidates.length === 0) return [];
  const syntheticJob = {
    id: input.job.id,
    profileId: input.job.profileId,
    threadId: input.messages[0]?.threadId ?? "00000000-0000-4000-8000-000000000000",
    sourceRunId: input.job.sourceRunId ?? "00000000-0000-4000-8000-000000000000",
    sourceTokenTotal: input.job.sourceEndTokenWatermark,
    status: "running",
    attempts: input.job.attempts,
    availableAt: input.job.availableAt,
    leaseExpiresAt: input.job.leaseExpiresAt,
    lockedAt: input.job.lockedAt,
    lockedBy: input.job.lockedBy,
    lastErrorCode: null,
    lastErrorMessage: null,
    createdAt: input.job.createdAt,
    updatedAt: input.job.updatedAt,
    completedAt: null,
  } as const;
  const sourceMessages = input.messages.map((message) => ({ messageId: message.messageId, profileId: message.profileId, threadId: message.threadId, content: message.content }));
  return candidates.flatMap((candidate) => {
    try {
      validateMemoryContentSafety(candidate.proposedContent);
      if (/\b(?:password|api[ _-]?key|access[ _-]?token|private[ _-]?key|client[ _-]?secret|secret)\b\s*(?:is|=|:)\s*\S+/i.test(candidate.proposedContent)) throw new Error("candidate secret");
      return validateConsolidationProposals({ job: syntheticJob, messages: sourceMessages, items: input.savedItems }, [candidate]);
    } catch {
      // Candidate extraction is optional. Any unsafe, weak, ambiguous, or
      // malformed proposal is dropped; it cannot block the derived snapshot.
      return [];
    }
  });
}

function emptyDocument(): ReferenceHistoryDocument {
  const base = { ongoingWork: [], recurringPreferences: [], relationshipsContext: [], recentChanges: [], boundedPatterns: [] } satisfies Omit<ReferenceHistoryDocument, "version" | "renderedText">;
  return { version: "iris-reference-history-v1", ...base, renderedText: "" };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Reference history worker time bound reached.")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

function safeWorkerError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /invalid|conflict|foreign|snapshot|source|constraint|lease/i.test(message) ? message.slice(0, 500) : "Reference history synthesis failed.";
}

function latestVersionMismatch(job: ReferenceHistoryJob, latest: ReferenceHistorySnapshot | null) {
  return Boolean(latest && latest.synthesizerVersion !== job.synthesizerVersion);
}

export async function processReferenceHistoryJobs(options: ReferenceHistoryWorkerOptions): Promise<ReferenceHistoryWorkerResult> {
  const result: ReferenceHistoryWorkerResult = { claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0, invalidated: 0 };
  const workerId = (options.workerId ?? `iris-reference-${crypto.randomUUID()}`).slice(0, 120);
  const maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? 25_000, 60_000));
  const startedAt = Date.now();
  const jobs = await options.store.claimReferenceHistoryJobs(workerId, options.limit ?? 1, options.leaseSeconds ?? 120);
  result.claimed = jobs.length;
  for (const job of jobs) {
    try {
      if (Date.now() - startedAt >= maxDurationMs) throw new Error("Reference history worker time bound reached.");
      const controls = await options.store.getControls(job.profileId);
      if (!controls.referenceHistoryEnabled) {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "REFERENCE_HISTORY_DISABLED", errorMessage: "Cross-chat reference history is disabled for this profile." });
        result.skipped += 1;
        continue;
      }
      const latest = await options.store.getLatestSnapshot(job.profileId);
      const rebuildForVersion = !job.rebuildFromRaw && latestVersionMismatch(job, latest);
      const rebuildFromRaw = job.rebuildFromRaw || rebuildForVersion;
      const [messages, savedItems, suppressions, memoryRevision] = await Promise.all([
        options.store.listSourceMessages({ profileId: job.profileId, afterTokenWatermark: job.sourceStartTokenWatermark, rebuildFromRaw }),
        options.memoryStore.listItems(job.profileId),
        options.memoryStore.listActiveSuppressions ? options.memoryStore.listActiveSuppressions(job.profileId) : Promise.resolve([]),
        options.memoryStore.getCurrentRevision(job.profileId),
      ]);
      if (messages.some((message) => message.profileId !== job.profileId)) throw new Error("Reference history source message is outside the profile.");
      const previousSnapshot = rebuildFromRaw ? null : latest;
      if (!job.rebuildFromRaw && latest && latest.id !== job.expectedSnapshotId) {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "conflict", errorCode: "STALE_REFERENCE_HISTORY_SOURCE", errorMessage: "A newer reference-history snapshot already exists." });
        result.conflicts += 1;
        continue;
      }
      if (messages.length === 0 && !rebuildFromRaw) {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_NEW_SOURCE_MESSAGES", errorMessage: "No new retained source messages were available." });
        result.skipped += 1;
        continue;
      }
      if (latest && !rebuildFromRaw && latest.coveredTokenWatermark >= job.sourceEndTokenWatermark) {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "REFERENCE_HISTORY_ALREADY_CURRENT", errorMessage: "An equivalent or newer snapshot already exists." });
        result.skipped += 1;
        continue;
      }
      const sourceHash = hashReferenceHistoryInput({ profileId: job.profileId, messages, previousSnapshot, savedItems, suppressions, synthesizerVersion: job.synthesizerVersion });
      if (latest && !job.rebuildFromRaw && latest.sourceHash === sourceHash && latest.coveredTokenWatermark >= job.sourceEndTokenWatermark) {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "REFERENCE_HISTORY_ALREADY_CURRENT", errorMessage: "An equivalent snapshot already exists." });
        result.skipped += 1;
        continue;
      }
      const synthesis = messages.length === 0 && rebuildFromRaw
        ? emptyDocument()
        : await withTimeout(options.synthesizer.synthesize({ job, messages, previousSnapshot, savedItems, suppressions }), Math.max(1_000, maxDurationMs - (Date.now() - startedAt)));
      const synthesisResult: ReferenceHistorySynthesisResult = "document" in synthesis
        ? synthesis as ReferenceHistorySynthesisResult
        : { document: synthesis as unknown as ReferenceHistoryDocument, memoryCandidates: [] };
      const validMemoryCandidates = validateReferenceHistoryCandidates({ job, messages, previousSnapshot, savedItems, suppressions }, synthesisResult.memoryCandidates);
      if (validMemoryCandidates.length > 0 && options.onValidatedMemoryCandidates) {
        await options.onValidatedMemoryCandidates({ profileId: job.profileId, job, candidates: validMemoryCandidates });
      }
      const currentMemoryRevision = await options.memoryStore.getCurrentRevision(job.profileId);
      if (currentMemoryRevision !== memoryRevision) throw new Error("Saved memory constraints changed during synthesis.");
      const lastMessage = messages.at(-1);
      const snapshot = {
        profileId: job.profileId,
        document: applyReferenceHistoryConstraints(synthesisResult.document, { savedItems, suppressions, changedMemoryRevision: Boolean(previousSnapshot && previousSnapshot.memoryRevision < memoryRevision) }),
        renderedText: applyReferenceHistoryConstraints(synthesisResult.document, { savedItems, suppressions, changedMemoryRevision: Boolean(previousSnapshot && previousSnapshot.memoryRevision < memoryRevision) }).renderedText,
        sourceRanges: mergeSourceRanges(previousSnapshot?.sourceRanges ?? [], sourceRanges(messages)),
        coveredTokenWatermark: Math.max(job.sourceEndTokenWatermark, lastMessage?.tokenEnd ?? 0),
        coveredThroughAt: lastMessage?.createdAt ?? previousSnapshot?.coveredThroughAt ?? null,
        sourceHash,
        memoryRevision,
        model: job.model,
        synthesizerVersion: job.synthesizerVersion,
        previousSnapshotId: previousSnapshot?.id ?? null,
      } satisfies Omit<ReferenceHistorySnapshot, "id" | "createdAt" | "revision" | "status">;
      const applied = await options.store.applyReferenceHistorySnapshot({ profileId: job.profileId, jobId: job.id, workerId, snapshot, expectedSnapshotId: job.expectedSnapshotId, expectedSnapshotRevision: job.expectedSnapshotRevision });
      if (applied === "conflict") {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "conflict", errorCode: "STALE_REFERENCE_HISTORY_SNAPSHOT", errorMessage: "Reference-history state changed while synthesis was running." });
        result.conflicts += 1;
      } else if (applied === "invalidated") {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "REFERENCE_HISTORY_VERSION_INVALIDATED", errorMessage: "A rebuild is required for this snapshot version." });
        result.invalidated += 1;
        result.skipped += 1;
      } else {
        await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "completed" });
        result.completed += 1;
      }
    } catch (error) {
      const retry = job.attempts < 3;
      await options.store.finishReferenceHistoryJob({ profileId: job.profileId, jobId: job.id, workerId, status: "failed", errorCode: "REFERENCE_HISTORY_FAILED", errorMessage: safeWorkerError(error), retry, availableAt: retry ? new Date(Date.now() + 30_000).toISOString() : null });
      result.failed += 1;
    }
  }
  return result;
}

export function createProductionReferenceHistoryWorker(options: Omit<ReferenceHistoryWorkerOptions, "store" | "memoryStore" | "synthesizer"> = {}) {
  if (process.env.MEMORY_REFERENCE_HISTORY_ENABLED !== "true") {
    return Promise.resolve<ReferenceHistoryWorkerResult>({ claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0, invalidated: 0 });
  }
  return processReferenceHistoryJobs({ store: createSupabaseReferenceHistoryStore(), memoryStore: createSupabaseMemoryStore(), synthesizer: createProductionReferenceHistorySynthesizer(), ...options });
}

export function referenceHistoryPromptIsFresh(snapshot: ReferenceHistorySnapshot | null, currentMemoryRevision: number) {
  return Boolean(snapshot
    && snapshot.status === "active"
    && snapshot.synthesizerVersion === REFERENCE_HISTORY_SYNTHESIZER_VERSION
    && snapshot.memoryRevision >= currentMemoryRevision);
}
