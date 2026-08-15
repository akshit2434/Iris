import "server-only";

import { createProductionChatModel, type AgentModel } from "@/server/agent";
import type { ThreadCompactionJob, ThreadCompactionMessage, ThreadCompactionStore } from "@/server/memory/types";
import { createSupabaseThreadCompactionStore } from "@/server/memory/compaction-repository";

export const DEFAULT_THREAD_COMPACTION_MIN_MESSAGES = 80;
export const DEFAULT_THREAD_COMPACTION_RECENT_TAIL_MESSAGES = 24;
const MAX_SUMMARY_LENGTH = 12_000;
const MAX_PINNED_NOTES = 12;
const MAX_PINNED_NOTE_LENGTH = 500;

export type ThreadCompactorInput = {
  job: ThreadCompactionJob;
  messages: readonly ThreadCompactionMessage[];
  continuitySummary: string | null;
  pinnedNotes: readonly string[];
};

export type ThreadCompactionResult = {
  continuitySummary: string;
  pinnedNotes: string[];
};

export type ThreadCompactor = {
  compact: (input: ThreadCompactorInput) => Promise<ThreadCompactionResult>;
};

function boundedEnvInteger(name: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, min), max) : fallback;
}

export function getThreadCompactionConfig() {
  return {
    minMessages: boundedEnvInteger("THREAD_COMPACTION_MIN_MESSAGES", DEFAULT_THREAD_COMPACTION_MIN_MESSAGES, 20, 500),
    recentTailMessages: boundedEnvInteger("THREAD_COMPACTION_RECENT_TAIL_MESSAGES", DEFAULT_THREAD_COMPACTION_RECENT_TAIL_MESSAGES, 4, 100),
  };
}

export function shouldEnqueueThreadCompaction(input: { messageCount: number; minMessages?: number }) {
  return Number.isSafeInteger(input.messageCount) && input.messageCount >= (input.minMessages ?? DEFAULT_THREAD_COMPACTION_MIN_MESSAGES);
}

export function validateThreadCompactionResult(value: unknown): ThreadCompactionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Compactor output was not an object.");
  const candidate = value as Record<string, unknown>;
  const summary = typeof candidate.continuitySummary === "string" ? candidate.continuitySummary.replace(/\s+/g, " ").trim() : "";
  if (!summary || summary.length > MAX_SUMMARY_LENGTH) throw new Error("Compactor summary is invalid or too large.");
  if (!Array.isArray(candidate.pinnedNotes) || candidate.pinnedNotes.length > MAX_PINNED_NOTES) throw new Error("Compactor pinned notes are invalid.");
  const pinnedNotes = candidate.pinnedNotes.map((note) => {
    if (typeof note !== "string") throw new Error("Compactor pinned note is invalid.");
    const normalized = note.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length > MAX_PINNED_NOTE_LENGTH) throw new Error("Compactor pinned note is invalid.");
    return normalized;
  });
  return { continuitySummary: summary, pinnedNotes };
}

export function createInjectedThreadCompactor(producer: (input: ThreadCompactorInput) => Promise<unknown>): ThreadCompactor {
  return {
    async compact(input) {
      return validateThreadCompactionResult(await producer(input));
    },
  };
}

function parseModelJson(value: unknown) {
  const content = value && typeof value === "object" && "content" in value ? (value as { content?: unknown }).content : value;
  if (typeof content !== "string") return null;
  const normalized = content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(normalized) as unknown; } catch { return null; }
}

export function createProductionThreadCompactor(model: AgentModel = createProductionChatModel()): ThreadCompactor {
  return createInjectedThreadCompactor(async (input) => {
    const prompt = `Return JSON only with continuitySummary and pinnedNotes. Summarize only the supplied ordered messages through the exact checkpoint. Preserve decisions, open questions, constraints, commitments, and uncertainty. Do not invent facts, erase disagreement, include secrets, or quote long passages. Keep pinnedNotes intentionally small.\n<checkpoint>${input.job.checkpointMessageId}</checkpoint>\n<existing-summary>${JSON.stringify(input.continuitySummary)}</existing-summary>\n<existing-pinned-notes>${JSON.stringify(input.pinnedNotes)}</existing-pinned-notes>\n<messages>${JSON.stringify(input.messages)}</messages>`;
    const response = await model.invoke(prompt, { temperature: 0.1, maxTokens: 1_500 } as never);
    const parsed = parseModelJson(response);
    if (!parsed) throw new Error("Compactor returned invalid JSON.");
    return parsed;
  });
}

export type ThreadCompactionWorkerOptions = {
  store: ThreadCompactionStore;
  compactor: ThreadCompactor;
  workerId?: string;
  limit?: number;
  leaseSeconds?: number;
  maxDurationMs?: number;
};

export type ThreadCompactionWorkerResult = {
  claimed: number;
  completed: number;
  conflicts: number;
  skipped: number;
  failed: number;
};

function safeCompactionError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /invalid|conflict|checkpoint|lease/i.test(message) ? message.slice(0, 500) : "Thread compaction failed.";
}

export async function processThreadCompactionJobs(options: ThreadCompactionWorkerOptions): Promise<ThreadCompactionWorkerResult> {
  const result: ThreadCompactionWorkerResult = { claimed: 0, completed: 0, conflicts: 0, skipped: 0, failed: 0 };
  if (process.env.THREAD_COMPACTION_ENABLED !== "true") return result;
  const workerId = (options.workerId ?? `iris-compactor-${crypto.randomUUID()}`).slice(0, 120);
  const maxDurationMs = Math.max(1_000, Math.min(options.maxDurationMs ?? 25_000, 60_000));
  const startedAt = Date.now();
  const jobs = await options.store.claimCompactionJobs(workerId, options.limit ?? 1, options.leaseSeconds ?? 120);
  result.claimed = jobs.length;
  for (const job of jobs) {
    try {
      if (Date.now() - startedAt >= maxDurationMs) throw new Error("Thread compaction worker time bound reached.");
      const messages = await options.store.listCompactionMessages(job.profileId, job.threadId, job.checkpointMessageId);
      if (messages.length === 0) {
        await options.store.finishCompactionJob({ profileId: job.profileId, jobId: job.id, workerId, status: "skipped", errorCode: "NO_SOURCE_MESSAGES", errorMessage: "No ordered source messages were available." });
        result.skipped += 1;
        continue;
      }
      const continuity = options.store.readCompactionContext
        ? await options.store.readCompactionContext(job.profileId, job.threadId)
        : { continuitySummary: null, pinnedNotes: [] };
      const compacted = await options.compactor.compact({ job, messages, ...continuity });
      const status = await options.store.applyCompactionCheckpoint({
        profileId: job.profileId,
        jobId: job.id,
        workerId,
        summary: compacted.continuitySummary,
        pinnedNotes: compacted.pinnedNotes,
        checkpointMessageId: job.checkpointMessageId,
        checkpointCreatedAt: job.checkpointCreatedAt,
      });
      if (status === "conflict") {
        await options.store.finishCompactionJob({ profileId: job.profileId, jobId: job.id, workerId, status: "conflict", errorCode: "STALE_CHECKPOINT", errorMessage: "A newer continuity checkpoint already exists." });
        result.conflicts += 1;
      } else {
        await options.store.finishCompactionJob({ profileId: job.profileId, jobId: job.id, workerId, status: "completed" });
        result.completed += 1;
      }
    } catch (error) {
      const retry = job.attempts < 3;
      await options.store.finishCompactionJob({ profileId: job.profileId, jobId: job.id, workerId, status: "failed", errorCode: "COMPACTION_FAILED", errorMessage: safeCompactionError(error), retry, availableAt: retry ? new Date(Date.now() + 30_000).toISOString() : null });
      result.failed += 1;
    }
  }
  return result;
}

export function createProductionThreadCompactionWorker(options: Omit<ThreadCompactionWorkerOptions, "store" | "compactor"> = {}) {
  return processThreadCompactionJobs({ store: createSupabaseThreadCompactionStore(), compactor: createProductionThreadCompactor(), ...options });
}
