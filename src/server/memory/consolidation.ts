import "server-only";

import { createProductionChatModel, type AgentModel } from "@/server/agent";
import { hashMemoryContent } from "@/server/memory/hash";
import { createSupabaseMemoryGovernanceStore } from "@/server/memory/governance-repository";
import { createSupabaseMemoryStore } from "@/server/memory/repository";
import type {
  CanonicalMemoryDocument,
  MemoryConsolidationJob,
  MemoryGovernanceStore,
  MemoryMessageForIndex,
  MemoryMutationProposal,
  MemoryProposalApplyResult,
  MemoryStore,
} from "@/server/memory/types";
import { validateCanonicalMarkdown, validateLogicalKey, validateMemoryUuid } from "@/server/memory/validation";

const MAX_PROPOSALS = 3;
const MAX_SOURCE_MESSAGES = 10;
const MAX_PROPOSAL_MARKDOWN = 20_000;

export type ConsolidationProposalInput = {
  logicalKey: string;
  proposedContentMarkdown: string;
  expectedDocumentRevision: number | null;
  mutationKind: "create" | "update" | "merge";
  sourceMessageIds: string[];
  rationale?: string | null;
};

export type ConsolidatorInput = {
  job: MemoryConsolidationJob;
  messages: readonly MemoryMessageForIndex[];
  documents: readonly CanonicalMemoryDocument[];
};

export type MemoryConsolidator = {
  propose: (input: ConsolidatorInput) => Promise<ConsolidationProposalInput[]>;
};

export function shouldEnqueueConsolidation(input: { runStatus: "completed" | "failed"; assistantPersisted: boolean }) {
  return input.runStatus === "completed" && input.assistantPersisted;
}

export function validateConsolidationProposals(input: ConsolidatorInput, proposals: readonly ConsolidationProposalInput[]) {
  if (proposals.length > MAX_PROPOSALS) throw new Error("Consolidator returned too many proposals.");
  const messageIds = new Set(input.messages.map((message) => message.messageId));
  const keys = new Set<string>();
  return proposals.map((proposal, index) => {
    const logicalKey = validateLogicalKey(proposal.logicalKey);
    const contentMarkdown = validateCanonicalMarkdown(proposal.proposedContentMarkdown.trim());
    if (contentMarkdown.length > MAX_PROPOSAL_MARKDOWN) throw new Error("Consolidator proposal is too large.");
    if (keys.has(logicalKey)) throw new Error("Consolidator returned duplicate logical keys.");
    keys.add(logicalKey);
    if (proposal.mutationKind === "create" && proposal.expectedDocumentRevision !== null) throw new Error("Create proposals must use a null expected revision.");
    if (proposal.mutationKind !== "create" && (proposal.expectedDocumentRevision === null || !Number.isSafeInteger(proposal.expectedDocumentRevision) || proposal.expectedDocumentRevision < 0)) {
      throw new Error("Update proposals require an expected revision.");
    }
    if (proposal.sourceMessageIds.length < 1 || proposal.sourceMessageIds.length > MAX_SOURCE_MESSAGES) throw new Error("Consolidator source messages are out of bounds.");
    for (const sourceMessageId of proposal.sourceMessageIds) {
      validateMemoryUuid(sourceMessageId, "Proposal source message ID");
      if (!messageIds.has(sourceMessageId)) throw new Error("Consolidator returned a foreign source message.");
    }
    return {
      logicalKey,
      proposedContentMarkdown: contentMarkdown,
      expectedDocumentRevision: proposal.expectedDocumentRevision,
      mutationKind: proposal.mutationKind,
      sourceMessageIds: [...new Set(proposal.sourceMessageIds)],
      rationale: typeof proposal.rationale === "string" ? proposal.rationale.replace(/\s+/g, " ").trim().slice(0, 500) : null,
      proposalIndex: index,
    };
  });
}

function parseModelJson(value: unknown): unknown {
  const text = typeof value === "string"
    ? value
    : value && typeof value === "object" && "content" in value
      ? (value as { content?: unknown }).content
      : "";
  if (typeof text !== "string") return null;
  const normalized = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(normalized) as unknown; } catch { return null; }
}

export function createInjectedMemoryConsolidator(producer: (input: ConsolidatorInput) => Promise<unknown>): MemoryConsolidator {
  return {
    async propose(input) {
      const raw = await producer(input);
      if (!Array.isArray(raw)) throw new Error("Consolidator output was not a proposal list.");
      return validateConsolidationProposals(input, raw as ConsolidationProposalInput[]).map(({ proposalIndex: _proposalIndex, ...proposal }) => proposal);
    },
  };
}

export function createProductionMemoryConsolidator(model: AgentModel = createProductionChatModel()): MemoryConsolidator {
  return createInjectedMemoryConsolidator(async (input) => {
    const prompt = `Return JSON only: an array of at most ${MAX_PROPOSALS} canonical memory proposals. Each proposal must have logicalKey, proposedContentMarkdown (full replacement Markdown), expectedDocumentRevision (number or null), mutationKind (create/update/merge), sourceMessageIds (IDs from the supplied messages only), and rationale. Do not create memory for transient chatter, secrets, or speculation. Do not invent source IDs.\n<messages>${JSON.stringify(input.messages)}</messages>\n<current-memory>${JSON.stringify(input.documents.map((document) => ({ logicalKey: document.logicalKey, contentMarkdown: document.contentMarkdown, documentRevision: document.documentRevision })))}</current-memory>`;
    const response = await model.invoke(prompt, { temperature: 0.1, maxTokens: 3_000 } as never);
    return parseModelJson(response);
  });
}

export type ConsolidationWorkerOptions = {
  governanceStore: MemoryGovernanceStore;
  memoryStore: MemoryStore;
  consolidator: MemoryConsolidator;
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
  indexDerived?: (messages: readonly MemoryMessageForIndex[]) => Promise<void>;
  maxDurationMs?: number;
};

export type ConsolidationWorkerResult = {
  claimed: number;
  completed: number;
  skipped: number;
  failed: number;
  conflicts: number;
  indexingErrors: number;
};

function safeWorkerError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /stale|conflict|foreign|invalid|proposal/i.test(message) ? message.slice(0, 500) : "Consolidation processing failed.";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Consolidation worker time bound reached.")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

export async function processConsolidationJobs(options: ConsolidationWorkerOptions): Promise<ConsolidationWorkerResult> {
  const workerId = (options.workerId ?? `iris-worker-${crypto.randomUUID()}`).slice(0, 120);
  const startedAt = Date.now();
  const maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? 25_000, 60_000));
  const jobs = await options.governanceStore.claimConsolidationJobs(workerId, options.limit ?? 1, options.leaseSeconds ?? 120);
  const result: ConsolidationWorkerResult = { claimed: jobs.length, completed: 0, skipped: 0, failed: 0, conflicts: 0, indexingErrors: 0 };

  for (const job of jobs) {
    try {
      if (Date.now() - startedAt >= maxDurationMs) throw new Error("Consolidation worker time bound reached.");
      const [messages, documents] = await Promise.all([
        options.governanceStore.listJobMessages(job.profileId, job.threadId, job.sourceRunId, MAX_SOURCE_MESSAGES),
        options.memoryStore.listDocuments(job.profileId),
      ]);
      if (messages.length === 0) {
        await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_SOURCE_MESSAGES", errorMessage: "No user-authored source messages were available." });
        result.skipped += 1;
        continue;
      }
      const proposals = await withTimeout(options.consolidator.propose({ job, messages, documents }), Math.max(1_000, maxDurationMs - (Date.now() - startedAt)));
      if (proposals.length === 0) {
        await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_PROPOSALS", errorMessage: "No durable memory update was justified." });
        result.skipped += 1;
        continue;
      }
      let conflicts = 0;
      for (const [index, proposal] of proposals.entries()) {
        const normalized = validateConsolidationProposals({ job, messages, documents }, [proposal])[0];
        const stored = await options.governanceStore.insertMutationProposal({
          profileId: job.profileId,
          threadId: job.threadId,
          sourceRunId: job.sourceRunId,
          jobId: job.id,
          proposalIndex: index,
          idempotencyKey: `consolidation:${job.sourceRunId}:${index}:${hashMemoryContent(normalized.proposedContentMarkdown)}`,
          logicalKey: normalized.logicalKey,
          proposedContentMarkdown: normalized.proposedContentMarkdown,
          expectedDocumentRevision: normalized.expectedDocumentRevision,
          mutationKind: normalized.mutationKind,
          sourceMessageIds: normalized.sourceMessageIds,
          rationale: normalized.rationale,
        });
        const applied = await options.governanceStore.applyMutationProposal(job.profileId, job.id, stored.id, workerId);
        if (applied.status === "conflict" || applied.status === "rejected") conflicts += 1;
      }
      result.conflicts += conflicts;
      if (process.env.MEMORY_SEMANTIC_INDEXING_ENABLED === "true" && options.indexDerived) {
        try { await options.indexDerived(messages); } catch { result.indexingErrors += 1; }
      }
      await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: conflicts === proposals.length ? "skipped" : "completed", errorCode: conflicts > 0 ? "PROPOSAL_CONFLICT" : null, errorMessage: conflicts > 0 ? `${conflicts} proposal(s) conflicted.` : null });
      if (conflicts === proposals.length) result.skipped += 1; else result.completed += 1;
    } catch (error) {
      const retry = job.attempts < 3;
      await options.governanceStore.finishConsolidationJob({ profileId: job.profileId, jobId: job.id, workerId, status: "failed", errorCode: "CONSOLIDATION_FAILED", errorMessage: safeWorkerError(error), retry, availableAt: retry ? new Date(Date.now() + Math.min(300_000, 30_000 * 2 ** Math.max(0, job.attempts - 1))).toISOString() : null });
      result.failed += 1;
    }
  }
  return result;
}

export function createProductionConsolidationWorker(options: Omit<ConsolidationWorkerOptions, "governanceStore" | "memoryStore" | "consolidator"> = {}) {
  return processConsolidationJobs({
    governanceStore: createSupabaseMemoryGovernanceStore(),
    memoryStore: createSupabaseMemoryStore(),
    consolidator: createProductionMemoryConsolidator(),
    ...options,
  });
}

export type { MemoryMutationProposal, MemoryProposalApplyResult };
