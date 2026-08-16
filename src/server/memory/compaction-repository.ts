import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";
import type {
  ContinuityCheckpointDocument,
  ThreadContinuityCheckpoint,
  ThreadContinuityJob,
  ThreadContinuityMessage,
  ThreadContinuityStore,
} from "@/server/memory/types";
import { assertMemoryProfileId, normalizeMemoryLimit, validateMemoryUuid } from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

function toJob(row: Database["public"]["Tables"]["thread_continuity_jobs"]["Row"]): ThreadContinuityJob {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    sourceRunId: row.source_run_id,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    expectedCheckpointId: row.expected_checkpoint_id,
    expectedContinuityRevision: row.expected_continuity_revision,
    sourceStartMessageId: row.source_start_message_id,
    sourceEndMessageId: row.source_end_message_id,
    sourceStartOrdinal: row.source_start_ordinal,
    sourceEndOrdinal: row.source_end_ordinal,
    sourceEstimatedTokens: row.source_estimated_tokens,
    projectedInputTokens: row.projected_input_tokens,
    safeInputBudgetTokens: row.safe_input_budget_tokens,
    inputHash: row.input_hash,
    model: row.model,
    tokenizerProvider: row.tokenizer_provider,
    tokenizerVersion: row.tokenizer_version,
    rebuildFromRaw: row.rebuild_from_raw,
    availableAt: row.available_at,
    leaseExpiresAt: row.lease_expires_at,
    lockedAt: row.locked_at,
    lockedBy: row.locked_by,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}
function toCheckpoint(row: Database["public"]["Tables"]["thread_continuity_checkpoints"]["Row"]): ThreadContinuityCheckpoint {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    revision: row.revision,
    document: row.document as unknown as ContinuityCheckpointDocument,
    renderedText: row.rendered_text,
    coveredThroughOrdinal: row.covered_through_ordinal,
    coveredThroughMessageId: row.covered_through_message_id,
    coveredThroughCreatedAt: row.covered_through_created_at,
    sourceStartMessageId: row.source_start_message_id,
    sourceEndMessageId: row.source_end_message_id,
    sourceMessageIds: row.source_message_ids,
    sourceEstimatedTokens: row.source_estimated_tokens,
    renderedTokens: row.rendered_tokens,
    model: row.model,
    tokenizerProvider: row.tokenizer_provider,
    tokenizerVersion: row.tokenizer_version,
    summarizerVersion: row.summarizer_version,
    previousCheckpointId: row.previous_checkpoint_id,
    inputHash: row.input_hash,
    createdAt: row.created_at,
  };
}

export function createSupabaseThreadContinuityStore(database: MemoryDatabase = getDatabase()): ThreadContinuityStore {
  return {
    async enqueueContinuityJob(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.threadId, "Thread ID");
      validateMemoryUuid(input.sourceRunId, "Run ID");
      validateMemoryUuid(input.sourceStartMessageId, "Continuity source start message ID");
      validateMemoryUuid(input.sourceEndMessageId, "Continuity source end message ID");
      const { data, error } = await database.rpc("enqueue_thread_continuity_job", {
        p_profile_id: input.profileId,
        p_thread_id: input.threadId,
        p_source_run_id: input.sourceRunId,
        p_source_start_message_id: input.sourceStartMessageId,
        p_source_end_message_id: input.sourceEndMessageId,
        p_source_start_ordinal: input.sourceStartOrdinal,
        p_source_end_ordinal: input.sourceEndOrdinal,
        p_source_estimated_tokens: input.sourceEstimatedTokens,
        p_projected_input_tokens: input.projectedInputTokens,
        p_safe_input_budget_tokens: input.safeInputBudgetTokens,
        p_input_hash: input.inputHash,
        p_model: input.model,
        p_tokenizer_provider: input.tokenizerProvider,
        p_tokenizer_version: input.tokenizerVersion,
        p_rebuild_from_raw: input.rebuildFromRaw ?? false,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? toJob(row) : null;
    },

    async claimContinuityJobs(workerId, limit = 1, leaseSeconds = 120) {
      const { data, error } = await database.rpc("claim_thread_continuity_jobs", {
        p_worker_id: workerId,
        p_limit: normalizeMemoryLimit(limit, 1),
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return (data ?? []).map(toJob);
    },

    async listContinuityMessages(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.threadId, "Thread ID");
      validateMemoryUuid(input.startMessageId, "Continuity source start message ID");
      validateMemoryUuid(input.endMessageId, "Continuity source end message ID");
      const { data, error } = await database
        .from("messages")
        .select("id, profile_id, thread_id, role, content, created_at, estimated_tokens, is_complete")
        .eq("profile_id", input.profileId)
        .eq("thread_id", input.threadId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(20_000);
      if (error) throw error;
      const rows = data ?? [];
      const start = input.rebuildFromRaw ? 0 : rows.findIndex((row) => row.id === input.startMessageId);
      const end = rows.findIndex((row) => row.id === input.endMessageId);
      if (start < 0 || end < start) return [];
      return rows.slice(start, end + 1).map((row, index) => ({
        messageId: row.id,
        profileId: row.profile_id,
        threadId: row.thread_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
        ordinal: start + index,
        estimatedTokens: row.estimated_tokens ?? 0,
        isComplete: row.is_complete,
      } satisfies ThreadContinuityMessage));
    },

    async readLatestContinuityCheckpoint(profileId, threadId) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      const { data, error } = await database
        .from("thread_continuity_checkpoints")
        .select("*")
        .eq("profile_id", profileId)
        .eq("thread_id", threadId)
        .order("revision", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? toCheckpoint(data) : null;
    },

    async applyContinuityCheckpoint(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Continuity job ID");
      validateMemoryUuid(input.checkpoint.coveredThroughMessageId, "Continuity checkpoint message ID");
      const { data, error } = await database.rpc("apply_thread_continuity_checkpoint", {
        p_profile_id: input.profileId,
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_expected_checkpoint_id: input.expectedCheckpointId,
        p_expected_continuity_revision: input.expectedContinuityRevision,
        p_document: input.checkpoint.document as unknown as Json,
        p_rendered_text: input.checkpoint.renderedText,
        p_covered_through_ordinal: input.checkpoint.coveredThroughOrdinal,
        p_covered_through_message_id: input.checkpoint.coveredThroughMessageId,
        p_covered_through_created_at: input.checkpoint.coveredThroughCreatedAt,
        p_source_start_message_id: input.checkpoint.sourceStartMessageId,
        p_source_end_message_id: input.checkpoint.sourceEndMessageId,
        p_source_message_ids: input.checkpoint.sourceMessageIds,
        p_source_estimated_tokens: input.checkpoint.sourceEstimatedTokens,
        p_rendered_tokens: input.checkpoint.renderedTokens,
        p_model: input.checkpoint.model,
        p_tokenizer_provider: input.checkpoint.tokenizerProvider,
        p_tokenizer_version: input.checkpoint.tokenizerVersion,
        p_summarizer_version: input.checkpoint.summarizerVersion,
        p_previous_checkpoint_id: input.checkpoint.previousCheckpointId,
        p_input_hash: input.checkpoint.inputHash,
      });
      if (error) throw error;
      if (data === "applied" || data === "conflict" || data === "invalidated") return data;
      throw new Error("Continuity checkpoint returned an invalid status.");
    },

    async invalidateContinuityCheckpoint(profileId, threadId, reason) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      const { error } = await database.rpc("invalidate_thread_continuity_checkpoint", {
        p_profile_id: profileId,
        p_thread_id: threadId,
        p_reason: reason.slice(0, 500),
      });
      if (error) throw error;
    },

    async finishContinuityJob(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Continuity job ID");
      const { data, error } = await database.rpc("finish_thread_continuity_job", {
        p_profile_id: input.profileId,
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_status: input.status,
        p_error_code: input.errorCode ?? null,
        p_error_message: input.errorMessage ?? null,
        p_retry: input.retry ?? false,
        p_available_at: input.availableAt ?? null,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Continuity job finish returned no row.");
      return toJob(row);
    },
  };
}
