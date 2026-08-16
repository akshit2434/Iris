import "server-only";

import { createProductionChatModel, type AgentModel } from "@/server/agent";
import { hashMemoryContent } from "@/server/memory/hash";
import { createSupabaseMemoryGovernanceStore } from "@/server/memory/governance-repository";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import type { MemoryControls, MemoryItem, MemoryConsolidationJob, MemoryGovernanceStore, MemoryMessageForIndex, MemoryMutationProposal, MemoryProposalApplyResult, MemoryStore, MemoryItemCategory, MemoryItemValueScope, MemoryItemOrigin } from "@/server/memory/types";
import { createSupabaseReferenceHistoryStore } from "@/server/memory/reference-history-repository";
import { validateCanonicalKey, validateMemoryContent, validateMemoryContentSafety, validateMemoryUuid } from "@/server/memory/validation";

const MAX_PROPOSALS = 3;
const MAX_SOURCE_MESSAGES = 50;
const MAX_PROPOSAL_SOURCES = 10;
const MAX_PROPOSAL_CONTENT = 20_000;
export const MIN_AUTOMATIC_CONSOLIDATION_TOKENS = 1_200;
export const CONSOLIDATION_IDLE_DEBOUNCE_MS = 30_000;

/**
 * Cheap, category-agnostic fast-lane gate. This only identifies a plausible
 * first-person durable statement; the structured consolidator remains the
 * authority on whether anything is actually saved.
 */
export function isMeaningfulMemoryCandidate(content: string) {
  const text = content.replace(/\s+/g, " ").trim();
  if (text.length < 18) return false;
  if (text.includes("?")) return false;
  if (/^(?:who|what|when|where|why|how|can|could|would|should|do|does|did|is|are|am|will|may)\b/i.test(text)) return false;
  if (/\b(?:remember|don't forget|do not forget)\b/i.test(text)) return true;
  return /\b(?:i|i'm|i've|i'd|my|we|we're|we've|our)\b/i.test(text);
}

export type ConsolidationProposalInput = {
  canonicalKey: string;
  proposedContent: string;
  category?: MemoryItemCategory;
  valueScope?: MemoryItemValueScope;
  origin?: MemoryItemOrigin;
  confidence?: number;
  importance?: number;
  sensitivity?: "normal" | "sensitive" | "highly_sensitive";
  expectedItemRevision: number | null;
  mutationKind: "create" | "update" | "supersede" | "merge";
  sourceMessageIds: string[];
  rationale?: string | null;
};
export type ConsolidatorInput = { job: MemoryConsolidationJob; messages: readonly MemoryMessageForIndex[]; items: readonly MemoryItem[] };
export type MemoryConsolidator = { propose: (input: ConsolidatorInput) => Promise<ConsolidationProposalInput[]> };

/**
 * This is a cheap preflight only. The durable per-thread token watermark and
 * debounce are checked again in the enqueue RPC, so concurrent requests cannot
 * accidentally create a second extraction job. `sourceTokenTotal` is the
 * cumulative serialized source size, not a message count.
 */
export function shouldEnqueueConsolidation(input: {
  runStatus: "completed" | "failed";
  assistantPersisted: boolean;
  sourceTokenTotal?: number;
  idleSignal?: boolean;
}) {
  if (input.runStatus !== "completed" || !input.assistantPersisted) return false;
  if (input.idleSignal === true) return true;
  // Preserve the old helper's safe default for callers that do not yet have a
  // token ledger. Production callers always pass the cumulative total.
  return input.sourceTokenTotal === undefined || input.sourceTokenTotal >= MIN_AUTOMATIC_CONSOLIDATION_TOKENS;
}

function normalizeMemoryText(value: string) { return value.replace(/\s+/g, " ").trim().toLocaleLowerCase(); }

function sourceContainsCorrectionSignal(messages: readonly MemoryMessageForIndex[]) {
  return messages.some((message) => /\b(?:actually|correction|correct(?:ion)?|instead|changed|no longer|update|now prefer|not anymore|i meant|used to)\b/i.test(message.content));
}

export function validateConsolidationProposals(input: ConsolidatorInput, proposals: readonly ConsolidationProposalInput[]) {
  if (proposals.length > MAX_PROPOSALS) throw new Error("Consolidator returned too many proposals.");
  const messageIds = new Set(input.messages.map((message) => message.messageId));
  const keys = new Set<string>();
  return proposals.map((proposal, index) => {
    const canonicalKey = validateCanonicalKey(proposal.canonicalKey);
    const content = validateMemoryContent(proposal.proposedContent.trim());
    validateMemoryContentSafety(content);
    if (content.length > MAX_PROPOSAL_CONTENT) throw new Error("Consolidator proposal is too large.");
    if (keys.has(canonicalKey)) throw new Error("Consolidator returned duplicate canonical keys.");
    keys.add(canonicalKey);
    if (proposal.mutationKind === "create" && proposal.expectedItemRevision !== null) throw new Error("Create proposals must use a null expected revision.");
    if (proposal.mutationKind !== "create" && (proposal.expectedItemRevision === null || !Number.isSafeInteger(proposal.expectedItemRevision) || proposal.expectedItemRevision < 0)) throw new Error("Update proposals require an expected revision.");
    if (proposal.sourceMessageIds.length < 1 || proposal.sourceMessageIds.length > MAX_PROPOSAL_SOURCES) throw new Error("Consolidator source messages are out of bounds.");
    for (const sourceMessageId of proposal.sourceMessageIds) {
      validateMemoryUuid(sourceMessageId, "Proposal source message ID");
      if (!messageIds.has(sourceMessageId)) throw new Error("Consolidator returned a foreign source message.");
    }
    if (proposal.confidence !== undefined && (!Number.isFinite(proposal.confidence) || proposal.confidence < 0 || proposal.confidence > 1)) throw new Error("Consolidator confidence is invalid.");
    if (proposal.importance !== undefined && (!Number.isFinite(proposal.importance) || proposal.importance < 0 || proposal.importance > 1)) throw new Error("Consolidator importance is invalid.");
    if ((proposal.confidence ?? 0.5) < 0.65) throw new Error("Automatic memory proposals require stronger evidence.");
    if ((proposal.sensitivity ?? "normal") !== "normal") throw new Error("Automatic consolidation cannot persist sensitive memory.");
    if ((proposal.origin ?? "inferred") !== "inferred") throw new Error("Automatic consolidation proposals must be inferred, not explicit.");
    const current = input.items.find((item) => item.canonicalKey === canonicalKey && item.status === "active");
    if (current && normalizeMemoryText(current.content) === normalizeMemoryText(content)) return null;
    if (current && proposal.mutationKind !== "supersede" && !sourceContainsCorrectionSignal(input.messages)) {
      throw new Error("Automatic memory conflict is ambiguous; no winner was selected.");
    }
    if (current && proposal.mutationKind === "supersede" && !sourceContainsCorrectionSignal(input.messages)) {
      throw new Error("Automatic supersession requires an explicit correction signal.");
    }
    return {
      canonicalKey, proposedContent: content, category: proposal.category ?? "other", valueScope: proposal.valueScope ?? "single", origin: proposal.origin ?? "inferred",
      confidence: proposal.confidence ?? 0.5, importance: proposal.importance ?? 0.5, sensitivity: proposal.sensitivity ?? "normal",
      expectedItemRevision: proposal.expectedItemRevision, mutationKind: proposal.mutationKind, sourceMessageIds: [...new Set(proposal.sourceMessageIds)],
      rationale: typeof proposal.rationale === "string" ? proposal.rationale.replace(/\s+/g, " ").trim().slice(0, 500) : null, proposalIndex: index,
    };
  }).filter((proposal): proposal is NonNullable<typeof proposal> => proposal !== null);
}

function parseModelJson(value: unknown): unknown {
  const text = typeof value === "string" ? value : value && typeof value === "object" && "content" in value ? (value as { content?: unknown }).content : "";
  if (typeof text !== "string") return null;
  const normalized = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(normalized) as unknown; } catch { return null; }
}

export function createInjectedMemoryConsolidator(producer: (input: ConsolidatorInput) => Promise<unknown>): MemoryConsolidator {
  return {
    async propose(input) {
      const raw = await producer(input);
      if (!Array.isArray(raw)) throw new Error("Consolidator output was not a proposal list.");
      try {
        return validateConsolidationProposals(input, raw as ConsolidationProposalInput[]).map(({ proposalIndex: _proposalIndex, ...proposal }) => proposal);
      } catch (error) {
        // Unsafe/weak/ambiguous automatic candidates are a normal rejection,
        // not a retryable provider failure. Structural contract violations
        // still fail loudly so a broken producer cannot be hidden.
        const message = error instanceof Error ? error.message : "";
        if (/cannot be saved|require stronger evidence|must be inferred|ambiguous|requires an explicit correction/i.test(message)) return [];
        throw error;
      }
    },
  };
}

export function createProductionMemoryConsolidator(model: AgentModel = createProductionChatModel()): MemoryConsolidator {
  return createInjectedMemoryConsolidator(async (input) => {
    const prompt = `Return JSON only: an array of at most ${MAX_PROPOSALS} structured memory proposals. Each proposal must have canonicalKey, proposedContent (plain natural-language content, not a Markdown file), category, valueScope, origin=inferred, confidence, importance, sensitivity=normal, expectedItemRevision (number or null), mutationKind (create/update/supersede/merge), sourceMessageIds (IDs from supplied messages only), and rationale. Use supersede only when the source explicitly corrects an existing fact. Do not create memory for transient chatter, credentials, one-time codes, transient moods or locations, role-play, sensitive third-party data, or speculative psychology. Do not invent source IDs. Ambiguous conflicts must produce no proposal.\n<messages>${JSON.stringify(input.messages)}</messages>\n<current-memory>${JSON.stringify(input.items.map((item) => ({ canonicalKey: item.canonicalKey, content: item.content, category: item.category, itemRevision: item.itemRevision })))}</current-memory>`;
    const response = await model.invoke(prompt, { temperature: 0.1, maxTokens: 3_000 } as never);
    return parseModelJson(response);
  });
}

export type ConsolidationWorkerOptions = { governanceStore: MemoryGovernanceStore; memoryStore: MemoryStore; consolidator: MemoryConsolidator; workerId?: string; job?: Pick<MemoryConsolidationJob, "id" | "profileId">; limit?: number; leaseSeconds?: number; indexDerived?: (messages: readonly MemoryMessageForIndex[]) => Promise<void>; maxDurationMs?: number; controlsReader?: (profileId: MemoryControls["profileId"]) => Promise<Pick<MemoryControls, "savedMemoryEnabled">> };
export type ConsolidationWorkerResult = { claimed: number; completed: number; skipped: number; failed: number; conflicts: number; indexingErrors: number };

function safeWorkerError(error: unknown) { const message = error instanceof Error ? error.message : ""; return /stale|conflict|foreign|invalid|proposal/i.test(message) ? message.slice(0, 500) : "Consolidation processing failed."; }
function withTimeout<T>(promise: Promise<T>, timeoutMs: number) { return new Promise<T>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("Consolidation worker time bound reached.")), timeoutMs); promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); }); }); }

export async function processConsolidationJobs(options: ConsolidationWorkerOptions): Promise<ConsolidationWorkerResult> {
  const workerId = (options.workerId ?? `iris-worker-${crypto.randomUUID()}`).slice(0, 120);
  const startedAt = Date.now(); const maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? 25_000, 60_000));
  const targetedJob = options.job && options.governanceStore.claimConsolidationJob
    ? await options.governanceStore.claimConsolidationJob(options.job.profileId, options.job.id, workerId, options.leaseSeconds ?? 120)
    : null;
  const jobs = options.job
    ? (targetedJob ? [targetedJob] : [])
    : await options.governanceStore.claimConsolidationJobs(workerId, options.limit ?? 1, options.leaseSeconds ?? 120);
  const result: ConsolidationWorkerResult = { claimed: jobs.length, completed: 0, skipped: 0, failed: 0, conflicts: 0, indexingErrors: 0 };
  for (const job of jobs) {
    try {
      if (Date.now() - startedAt >= maxDurationMs) throw new Error("Consolidation worker time bound reached.");
      if (options.controlsReader) {
        const controls = await options.controlsReader(job.profileId);
        if (!controls.savedMemoryEnabled) {
          await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "SAVED_MEMORY_DISABLED", errorMessage: "Saved memory is disabled for this profile." });
          result.skipped += 1;
          continue;
        }
      }
      const [messages, items] = await Promise.all([options.governanceStore.listJobMessages(job, MAX_SOURCE_MESSAGES), options.memoryStore.listItems(job.profileId)]);
      if (messages.length === 0) { await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_SOURCE_MESSAGES", errorMessage: "No user-authored source messages were available." }); result.skipped += 1; continue; }
      const proposals = await withTimeout(options.consolidator.propose({ job, messages, items }), Math.max(1_000, maxDurationMs - (Date.now() - startedAt)));
      if (proposals.length === 0) { await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_PROPOSALS", errorMessage: "No durable memory update was justified." }); result.skipped += 1; continue; }
      let conflicts = 0;
      for (const [index, proposal] of proposals.entries()) {
        const normalized = validateConsolidationProposals({ job, messages, items }, [proposal])[0];
        if (options.memoryStore.isSuppressed && await options.memoryStore.isSuppressed(job.profileId, normalized.canonicalKey, hashMemoryContent(normalized.proposedContent))) {
          conflicts += 1;
          continue;
        }
        const stored = await options.governanceStore.insertMutationProposal({ profileId: job.profileId, threadId: job.threadId, sourceRunId: job.sourceRunId, jobId: job.id, proposalIndex: index, idempotencyKey: `consolidation:${job.sourceRunId}:${index}:${hashMemoryContent(normalized.proposedContent)}`, canonicalKey: normalized.canonicalKey, proposedContent: normalized.proposedContent, category: normalized.category, valueScope: normalized.valueScope, origin: normalized.origin, confidence: normalized.confidence, importance: normalized.importance, sensitivity: normalized.sensitivity, expectedItemRevision: normalized.expectedItemRevision, mutationKind: normalized.mutationKind, sourceMessageIds: normalized.sourceMessageIds, rationale: normalized.rationale });
        const applied = await options.governanceStore.applyMutationProposal(job.profileId, job.id, stored.id, workerId);
        if (applied.status === "conflict" || applied.status === "rejected") conflicts += 1;
      }
      result.conflicts += conflicts;
      if (process.env.MEMORY_SEMANTIC_INDEXING_ENABLED !== "false" && options.indexDerived) { try { await options.indexDerived(messages); } catch { result.indexingErrors += 1; } }
      await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: conflicts === proposals.length ? "skipped" : "completed", errorCode: conflicts > 0 ? "PROPOSAL_CONFLICT" : null, errorMessage: conflicts > 0 ? `${conflicts} proposal(s) conflicted.` : null });
      if (conflicts === proposals.length) result.skipped += 1; else result.completed += 1;
    } catch (error) {
      const retry = job.attempts < 3;
      await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "failed", errorCode: "CONSOLIDATION_FAILED", errorMessage: safeWorkerError(error), retry, availableAt: retry ? new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** Math.max(0, job.attempts - 1))).toISOString() : null }); result.failed += 1;
    }
  }
  return result;
}

export function createProductionConsolidationWorker(options: Omit<ConsolidationWorkerOptions, "governanceStore" | "memoryStore" | "consolidator"> = {}) { return processConsolidationJobs({ governanceStore: createSupabaseMemoryGovernanceStore(), memoryStore: createSupabaseMemoryStore(), consolidator: createProductionMemoryConsolidator(), controlsReader: async (profileId) => createSupabaseReferenceHistoryStore().getControls(profileId), ...options }); }
export type { MemoryMutationProposal, MemoryProposalApplyResult };
