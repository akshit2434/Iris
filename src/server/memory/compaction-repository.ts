import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import type { ThreadCompactionJob, ThreadCompactionMessage, ThreadCompactionStore } from "@/server/memory/types";
import { assertMemoryProfileId, normalizeMemoryLimit, validateMemoryUuid } from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

function toJob(row: Database["public"]["Tables"]["thread_compaction_jobs"]["Row"]): ThreadCompactionJob {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    sourceRunId: row.source_run_id,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    expectedCompactedThroughMessageId: row.expected_compacted_through_message_id,
    expectedContinuityRevision: row.expected_continuity_revision,
    checkpointMessageId: row.checkpoint_message_id,
    checkpointCreatedAt: row.checkpoint_created_at,
    recentTailMessages: row.recent_tail_messages,
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

export function createSupabaseThreadCompactionStore(database: MemoryDatabase = getDatabase()): ThreadCompactionStore {
  return {
    async enqueueCompactionJob(profileId, threadId, sourceRunId, minMessages = 80, recentTailMessages = 24) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      validateMemoryUuid(sourceRunId, "Run ID");
      const { data, error } = await database.rpc("enqueue_thread_compaction_job", {
        p_profile_id: profileId,
        p_thread_id: threadId,
        p_source_run_id: sourceRunId,
        p_min_messages: minMessages,
        p_recent_tail_messages: recentTailMessages,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? toJob(row) : null;
    },

    async claimCompactionJobs(workerId, limit = 1, leaseSeconds = 120) {
      const { data, error } = await database.rpc("claim_thread_compaction_jobs", {
        p_worker_id: workerId,
        p_limit: normalizeMemoryLimit(limit, 1),
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return (data ?? []).map(toJob);
    },

    async listCompactionMessages(profileId, threadId, checkpointMessageId, limit = 160) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      validateMemoryUuid(checkpointMessageId, "Checkpoint message ID");
      const { data: checkpoint, error: checkpointError } = await database
        .from("messages")
        .select("created_at, id")
        .eq("id", checkpointMessageId)
        .eq("profile_id", profileId)
        .eq("thread_id", threadId)
        .maybeSingle();
      if (checkpointError) throw checkpointError;
      if (!checkpoint) return [];
      const { data, error } = await database
        .from("messages")
        .select("id, profile_id, thread_id, role, content, created_at")
        .eq("profile_id", profileId)
        .eq("thread_id", threadId)
        .or(`created_at.lt.${checkpoint.created_at},and(created_at.eq.${checkpoint.created_at},id.lte.${checkpoint.id})`)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(Math.min(normalizeMemoryLimit(limit, 160), 240));
      if (error) throw error;
      return (data ?? []).map((row) => ({
        messageId: row.id,
        profileId: row.profile_id,
        threadId: row.thread_id,
        role: row.role,
        content: row.content,
        createdAt: row.created_at,
      } satisfies ThreadCompactionMessage));
    },

    async readCompactionContext(profileId, threadId) {
      assertMemoryProfileId(profileId);
      validateMemoryUuid(threadId, "Thread ID");
      const { data, error } = await database
        .from("thread_context")
        .select("continuity_summary, pinned_notes")
        .eq("profile_id", profileId)
        .eq("thread_id", threadId)
        .maybeSingle();
      if (error) throw error;
      return { continuitySummary: data?.continuity_summary ?? null, pinnedNotes: data?.pinned_notes ?? [] };
    },

    async applyCompactionCheckpoint(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Compaction job ID");
      validateMemoryUuid(input.checkpointMessageId, "Checkpoint message ID");
      const { data, error } = await database.rpc("apply_thread_compaction_checkpoint", {
        p_profile_id: input.profileId,
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_continuity_summary: input.summary,
        p_pinned_notes: input.pinnedNotes,
        p_checkpoint_message_id: input.checkpointMessageId,
        p_checkpoint_created_at: input.checkpointCreatedAt,
      });
      if (error) throw error;
      return data === "applied" ? "applied" : "conflict";
    },

    async finishCompactionJob(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Compaction job ID");
      const { data, error } = await database.rpc("finish_thread_compaction_job", {
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
      if (!row) throw new Error("Compaction finish returned no job.");
      return toJob(row);
    },
  };
}
