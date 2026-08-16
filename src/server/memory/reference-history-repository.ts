import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";
import { createTokenEstimator } from "@/server/agent/token-budget";
import type { ProfileId } from "@/lib/profiles";
import {
  type MemoryControls,
  type ReferenceHistoryJob,
  type ReferenceHistoryMessage,
  type ReferenceHistorySnapshot,
  type ReferenceHistorySourceRange,
  type ReferenceHistoryStore,
  type ReferenceHistoryDocument,
  type ReferenceHistoryClaim,
} from "@/server/memory/types";
import { assertMemoryProfileId, normalizeMemoryLimit, validateMemoryUuid } from "@/server/memory/validation";

type MemoryDatabase = SupabaseClient<Database>;

function toControls(row: Database["public"]["Tables"]["profile_memory_settings"]["Row"]): MemoryControls {
  return {
    profileId: row.profile_id,
    savedMemoryEnabled: row.saved_memory_enabled,
    referenceHistoryEnabled: row.reference_history_enabled,
    updatedAt: row.updated_at,
  };
}

function toJob(row: Database["public"]["Tables"]["reference_history_jobs"]["Row"]): ReferenceHistoryJob {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceRunId: row.source_run_id,
    status: row.status,
    attempts: row.attempts,
    idempotencyKey: row.idempotency_key,
    expectedSnapshotId: row.expected_snapshot_id,
    expectedSnapshotRevision: row.expected_snapshot_revision,
    sourceStartTokenWatermark: row.source_start_token_watermark,
    sourceEndTokenWatermark: row.source_end_token_watermark,
    rebuildFromRaw: row.rebuild_from_raw,
    idleSignal: row.idle_signal,
    model: row.model,
    synthesizerVersion: row.synthesizer_version,
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

/**
 * Snapshots are JSON documents and older rows predate claim-level metadata.
 * Normalize their optional fields on read so the runtime can safely overlay
 * current memory and rebuild exact source actions without a destructive data
 * migration. The next Dreaming job writes the richer shape.
 */
function normalizeStoredDocument(value: unknown): ReferenceHistoryDocument {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sections = ["ongoingWork", "recurringPreferences", "relationshipsContext", "recentChanges", "boundedPatterns"] as const;
  const normalized = Object.fromEntries(sections.map((section) => {
    const claims = Array.isArray(record[section]) ? record[section] : [];
    return [section, claims.flatMap((claim): ReferenceHistoryClaim[] => {
      if (!claim || typeof claim !== "object" || Array.isArray(claim)) return [];
      const item = claim as Record<string, unknown>;
      if (typeof item.text !== "string" || item.text.trim().length === 0) return [];
      const sourceMessageIds = Array.isArray(item.sourceMessageIds)
        ? item.sourceMessageIds.filter((source): source is string => typeof source === "string").slice(0, 12)
        : [];
      return [{
        text: item.text.replace(/\s+/g, " ").trim().slice(0, 1_200),
        confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0.5,
        temporalQualifier: typeof item.temporalQualifier === "string" ? item.temporalQualifier.slice(0, 240) : null,
        uncertainty: typeof item.uncertainty === "string" ? item.uncertainty.slice(0, 240) : null,
        sourceMessageIds,
        sourceRanges: Array.isArray(item.sourceRanges) ? item.sourceRanges.slice(0, 200) as ReferenceHistorySourceRange[] : [],
        memoryKeys: Array.isArray(item.memoryKeys) ? item.memoryKeys.filter((key): key is string => typeof key === "string").slice(0, 8) : [],
        ...(item.stale === true ? { stale: true } : {}),
        ...(typeof item.memoryOverlay === "string" ? { memoryOverlay: item.memoryOverlay.slice(0, 1_200) } : {}),
      }];
    })];
  })) as Pick<ReferenceHistoryDocument, typeof sections[number]>;
  const base = { version: "iris-reference-history-v1" as const, ...normalized };
  const renderedText = typeof record.renderedText === "string" ? record.renderedText.slice(0, 16_000) : "";
  return { ...base, renderedText };
}

function toSnapshot(row: Database["public"]["Tables"]["profile_reference_history_snapshots"]["Row"]): ReferenceHistorySnapshot {
  return {
    id: row.id,
    profileId: row.profile_id,
    revision: row.revision,
    status: row.status,
    document: normalizeStoredDocument(row.document),
    renderedText: row.rendered_text,
    sourceRanges: row.source_ranges as unknown as ReferenceHistorySourceRange[],
    coveredTokenWatermark: row.covered_token_watermark,
    coveredThroughAt: row.covered_through_at,
    sourceHash: row.source_hash,
    memoryRevision: row.memory_revision,
    model: row.model,
    synthesizerVersion: row.synthesizer_version,
    previousSnapshotId: row.previous_snapshot_id,
    createdAt: row.created_at,
  };
}

export function createSupabaseReferenceHistoryStore(database: MemoryDatabase = getDatabase()): ReferenceHistoryStore {
  return {
    async getControls(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("profile_memory_settings")
        .upsert({ profile_id: profileId }, { onConflict: "profile_id" })
        .select("profile_id, saved_memory_enabled, reference_history_enabled, updated_at")
        .single();
      if (error) throw error;
      return toControls(data);
    },

    async updateControls(input) {
      assertMemoryProfileId(input.profileId);
      const updates: Database["public"]["Tables"]["profile_memory_settings"]["Update"] = {
        ...(input.savedMemoryEnabled === undefined ? {} : { saved_memory_enabled: input.savedMemoryEnabled }),
        ...(input.referenceHistoryEnabled === undefined ? {} : { reference_history_enabled: input.referenceHistoryEnabled }),
        updated_at: new Date().toISOString(),
      };
      const { data, error } = await database
        .from("profile_memory_settings")
        .upsert({ profile_id: input.profileId, ...updates }, { onConflict: "profile_id" })
        .select("profile_id, saved_memory_enabled, reference_history_enabled, updated_at")
        .single();
      if (error) throw error;
      return toControls(data);
    },

    async getLatestSnapshot(profileId) {
      assertMemoryProfileId(profileId);
      const { data, error } = await database
        .from("profile_reference_history_snapshots")
        .select("id, profile_id, revision, status, document, rendered_text, source_ranges, covered_token_watermark, covered_through_at, source_hash, memory_revision, model, synthesizer_version, previous_snapshot_id, created_at")
        .eq("profile_id", profileId)
        .eq("status", "active")
        .order("revision", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? toSnapshot(data) : null;
    },

    async listSourceMessages(input) {
      assertMemoryProfileId(input.profileId);
      const afterTokenWatermark = Number.isSafeInteger(input.afterTokenWatermark) && input.afterTokenWatermark >= 0
        ? input.afterTokenWatermark
        : 0;
      const { data, error } = await database
        .from("messages")
        .select("id, profile_id, thread_id, role, content, created_at, estimated_tokens, is_complete")
        .eq("profile_id", input.profileId)
        .eq("is_complete", true)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(100_000);
      if (error) throw error;
      const estimator = createTokenEstimator({ provider: "openrouter", model: "unknown" });
      let watermark = 0;
      const selected: ReferenceHistoryMessage[] = [];
      for (const row of data ?? []) {
        const estimatedTokens = Number.isSafeInteger(row.estimated_tokens) && (row.estimated_tokens ?? 0) > 0
          ? row.estimated_tokens as number
          : estimator.estimateMessage({ role: row.role, content: row.content });
        const tokenStart = watermark;
        watermark += estimatedTokens;
        if (input.rebuildFromRaw || watermark > afterTokenWatermark) {
          selected.push({
            messageId: row.id,
            profileId: row.profile_id,
            threadId: row.thread_id,
            role: row.role,
            content: row.content,
            createdAt: row.created_at,
            estimatedTokens,
            tokenStart,
            tokenEnd: watermark,
          });
        }
      }
      return selected;
    },

    async enqueueReferenceHistoryJob(input) {
      assertMemoryProfileId(input.profileId);
      if (input.sourceRunId) validateMemoryUuid(input.sourceRunId, "Reference history source run ID");
      const { data, error } = await database.rpc("enqueue_reference_history_job", {
        p_profile_id: input.profileId,
        p_source_run_id: input.sourceRunId ?? null,
        p_source_token_total: input.sourceTokenTotal ?? null,
        p_idle_signal: input.idleSignal ?? false,
        p_rebuild_from_raw: input.rebuildFromRaw ?? false,
        p_model: input.model ?? "openai/gpt-5.6-luna",
        p_synthesizer_version: input.synthesizerVersion ?? "iris-reference-history-v1",
        p_debounce_seconds: input.debounceSeconds ?? 30,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      return row ? toJob(row) : null;
    },

    async claimReferenceHistoryJobs(workerId, limit = 1, leaseSeconds = 120) {
      const { data, error } = await database.rpc("claim_reference_history_jobs", {
        p_worker_id: workerId,
        p_limit: normalizeMemoryLimit(limit, 1),
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw error;
      return (data ?? []).map(toJob);
    },

    async applyReferenceHistorySnapshot(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Reference history job ID");
      if (input.expectedSnapshotId) validateMemoryUuid(input.expectedSnapshotId, "Expected reference history snapshot ID");
      if (input.snapshot.previousSnapshotId) validateMemoryUuid(input.snapshot.previousSnapshotId, "Previous reference history snapshot ID");
      const { data, error } = await database.rpc("apply_reference_history_snapshot", {
        p_profile_id: input.profileId,
        p_job_id: input.jobId,
        p_worker_id: input.workerId,
        p_expected_snapshot_id: input.expectedSnapshotId,
        p_expected_snapshot_revision: input.expectedSnapshotRevision,
        p_document: input.snapshot.document as unknown as Json,
        p_rendered_text: input.snapshot.renderedText,
        p_source_ranges: input.snapshot.sourceRanges as unknown as Json,
        p_covered_token_watermark: input.snapshot.coveredTokenWatermark,
        p_covered_through_at: input.snapshot.coveredThroughAt,
        p_source_hash: input.snapshot.sourceHash,
        p_memory_revision: input.snapshot.memoryRevision,
        p_model: input.snapshot.model,
        p_synthesizer_version: input.snapshot.synthesizerVersion,
        p_previous_snapshot_id: input.snapshot.previousSnapshotId,
      });
      if (error) throw error;
      if (data === "applied" || data === "conflict" || data === "invalidated") return data;
      throw new Error("Reference history snapshot returned an invalid status.");
    },

    async finishReferenceHistoryJob(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.jobId, "Reference history job ID");
      const { data, error } = await database.rpc("finish_reference_history_job", {
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
      if (!row) throw new Error("Reference history job finish returned no row.");
      return toJob(row);
    },

    async invalidateReferenceHistorySnapshot(profileId, reason) {
      assertMemoryProfileId(profileId);
      const { error } = await database.rpc("invalidate_reference_history_snapshot", {
        p_profile_id: profileId,
        p_reason: reason.slice(0, 500),
      });
      if (error) throw error;
    },

    async clearReferenceHistoryData(profileId) {
      assertMemoryProfileId(profileId);
      const { error } = await database.rpc("clear_reference_history_data", { p_profile_id: profileId });
      if (error) throw error;
    },
  };
}
