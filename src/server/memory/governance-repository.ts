import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database } from "@/server/db/types";
import type { MemoryConsolidationJob, MemoryGovernanceStore, MemoryMessageForIndex, MemoryMutationProposal } from "@/server/memory/types";
import { assertMemoryProfileId, normalizeMemoryLimit, validateMemoryUuid } from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

function toJob(row: Database["public"]["Tables"]["memory_consolidation_jobs"]["Row"]): MemoryConsolidationJob {
  return { id: row.id, profileId: row.profile_id, threadId: row.thread_id, sourceRunId: row.source_run_id, status: row.status, attempts: row.attempts, availableAt: row.available_at, leaseExpiresAt: row.lease_expires_at, lockedAt: row.locked_at, lockedBy: row.locked_by, lastErrorCode: row.last_error_code, lastErrorMessage: row.last_error_message, createdAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at };
}

function toProposal(row: Database["public"]["Tables"]["memory_mutation_proposals"]["Row"]): MemoryMutationProposal {
  return { id: row.id, profileId: row.profile_id, threadId: row.thread_id, sourceRunId: row.source_run_id, jobId: row.job_id, proposalIndex: row.proposal_index, idempotencyKey: row.idempotency_key, canonicalKey: row.canonical_key, proposedContent: row.proposed_content, category: row.category, valueScope: row.value_scope, origin: row.origin, confidence: row.confidence, importance: row.importance, sensitivity: row.sensitivity, expectedItemRevision: row.expected_item_revision, mutationKind: row.mutation_kind, sourceMessageIds: row.source_message_ids, rationale: row.rationale, status: row.status, reason: row.reason, resultRevisionId: row.result_revision_id, createdAt: row.created_at, updatedAt: row.updated_at, appliedAt: row.applied_at };
}

const proposalColumns = "id, profile_id, thread_id, source_run_id, job_id, proposal_index, idempotency_key, canonical_key, proposed_content, category, value_scope, origin, confidence, importance, sensitivity, expected_item_revision, mutation_kind, source_message_ids, rationale, status, reason, result_revision_id, created_at, updated_at, applied_at";

export function createSupabaseMemoryGovernanceStore(database: MemoryDatabase = getDatabase()): MemoryGovernanceStore {
  return {
    async enqueueConsolidationJob(profileId, threadId, sourceRunId) {
      assertMemoryProfileId(profileId); validateMemoryUuid(threadId, "Thread ID"); validateMemoryUuid(sourceRunId, "Run ID");
      const { data, error } = await database.rpc("enqueue_memory_consolidation_job", { p_profile_id: profileId, p_thread_id: threadId, p_source_run_id: sourceRunId });
      if (error) throw error; const row = Array.isArray(data) ? data[0] : data; if (!row) throw new Error("Consolidation enqueue returned no job."); return toJob(row);
    },
    async claimConsolidationJobs(workerId, limit = 1, leaseSeconds = 120) {
      const { data, error } = await database.rpc("claim_memory_consolidation_jobs", { p_worker_id: workerId, p_limit: normalizeMemoryLimit(limit, 1), p_lease_seconds: leaseSeconds });
      if (error) throw error; return (data ?? []).map(toJob);
    },
    async finishConsolidationJob(input) {
      assertMemoryProfileId(input.profileId); validateMemoryUuid(input.jobId, "Job ID");
      const { data, error } = await database.rpc("finish_memory_consolidation_job", { p_profile_id: input.profileId, p_job_id: input.jobId, p_worker_id: input.workerId, p_status: input.status, p_error_code: input.errorCode ?? null, p_error_message: input.errorMessage ?? null, p_retry: input.retry ?? false, p_available_at: input.availableAt ?? null });
      if (error) throw error; const row = Array.isArray(data) ? data[0] : data; if (!row) throw new Error("Consolidation finish returned no job."); return toJob(row);
    },
    async listJobMessages(profileId, threadId, sourceRunId, limit = 10) {
      assertMemoryProfileId(profileId); validateMemoryUuid(threadId, "Thread ID"); validateMemoryUuid(sourceRunId, "Run ID");
      const { data, error } = await database.from("messages").select("id, thread_id, profile_id, content").eq("profile_id", profileId).eq("thread_id", threadId).eq("agent_run_id", sourceRunId).eq("role", "user").order("created_at", { ascending: true }).limit(normalizeMemoryLimit(limit, 10));
      if (error) throw error; return (data ?? []).map((row) => ({ messageId: row.id, profileId: row.profile_id, threadId: row.thread_id, content: row.content } satisfies MemoryMessageForIndex));
    },
    async insertMutationProposal(input) {
      assertMemoryProfileId(input.profileId); validateMemoryUuid(input.threadId, "Thread ID"); validateMemoryUuid(input.sourceRunId, "Run ID"); validateMemoryUuid(input.jobId, "Job ID");
      const insert = { profile_id: input.profileId, thread_id: input.threadId, source_run_id: input.sourceRunId, job_id: input.jobId, proposal_index: input.proposalIndex, idempotency_key: input.idempotencyKey, canonical_key: input.canonicalKey, proposed_content: input.proposedContent, category: input.category, value_scope: input.valueScope, origin: input.origin, confidence: input.confidence, importance: input.importance, sensitivity: input.sensitivity, expected_item_revision: input.expectedItemRevision, mutation_kind: input.mutationKind, source_message_ids: input.sourceMessageIds, rationale: input.rationale };
      const { data, error } = await database.from("memory_mutation_proposals").insert(insert).select(proposalColumns).single();
      if (!error && data) return toProposal(data);
      if (error?.code !== "23505") throw error ?? new Error("Memory proposal insert returned no row.");
      const { data: existing, error: existingError } = await database.from("memory_mutation_proposals").select(proposalColumns).eq("profile_id", input.profileId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
      if (existingError || !existing) throw existingError ?? new Error("Memory proposal replay returned no row.");
      return toProposal(existing);
    },
    async applyMutationProposal(profileId, jobId, proposalId, workerId) {
      assertMemoryProfileId(profileId); validateMemoryUuid(jobId, "Job ID"); validateMemoryUuid(proposalId, "Proposal ID");
      const { data, error } = await database.rpc("apply_memory_mutation_proposal", { p_profile_id: profileId, p_job_id: jobId, p_proposal_id: proposalId, p_worker_id: workerId });
      if (error) throw error; const row = Array.isArray(data) ? data[0] : data; if (!row) throw new Error("Proposal apply returned no result.");
      return { status: row.status, proposalId: row.proposal_id, itemId: row.item_id, itemRevision: row.item_revision, profileGlobalRevision: row.profile_global_revision, revisionId: row.revision_id, sourceId: row.source_id, reason: row.reason };
    },
  };
}
