import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { isProfileId, type ProfileId } from "@/lib/profiles";
import { getDatabase } from "@/server/db/client";
import type { Database, Json } from "@/server/db/types";
import { isTerminal, nextStatusOnEvent } from "./state-machine";
import {
  createLoopInputSchema,
  type Cadence,
  type LoopEventKind,
  type OpenLoopKind,
  type OpenLoopStatus,
} from "./types";

type AccountabilityDatabase = SupabaseClient<Database>;

type OpenLoopTableRow = Database["public"]["Tables"]["open_loops"]["Row"];
type LoopEventTableRow = Database["public"]["Tables"]["loop_events"]["Row"];
type ScheduledCheckTableRow = Database["public"]["Tables"]["scheduled_checks"]["Row"];
type CheckinDeliveryTableRow = Database["public"]["Tables"]["checkin_deliveries"]["Row"];
type LoopSuppressionTableRow = Database["public"]["Tables"]["loop_suppressions"]["Row"];

export type ScheduledCheckStatus = "pending" | "delivered" | "merged" | "cancelled" | "expired";
export type LoopEventActor = "user" | "agent" | "system";
export type CheckinDeliveryStatus = "pending" | "delivered" | "answered" | "cancelled";

export type OpenLoopRow = {
  id: string;
  profileId: ProfileId;
  title: string;
  details: string | null;
  kind: OpenLoopKind;
  status: OpenLoopStatus;
  dueAt: string | null;
  cadence: Cadence | null;
  originThreadId: string | null;
  originMessageId: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
};

export type LoopEventRow = {
  id: string;
  profileId: ProfileId;
  loopId: string;
  kind: LoopEventKind;
  detail: string | null;
  actor: LoopEventActor;
  sourceThreadId: string | null;
  sourceMessageId: string | null;
  agentRunId: string | null;
  metadata: Json;
  createdAt: string;
};

export type ScheduledCheckRow = {
  id: string;
  profileId: ProfileId;
  loopId: string;
  dueAt: string;
  status: ScheduledCheckStatus;
  attemptCount: number;
  escalationTier: number;
  deliveryId: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  claimedAt: string | null;
  createdAt: string;
};

export type DeliverableDueCheck = { check: ScheduledCheckRow; loop: OpenLoopRow };

export type MarkCheckDeliveredInput = {
  deliveryId: string;
  deliveredAt: string;
  attemptCount: number;
  escalationTier: number;
};

export type CheckinDeliveryRow = {
  id: string;
  profileId: ProfileId;
  threadId: string;
  messageId: string | null;
  summary: string | null;
  status: CheckinDeliveryStatus;
  createdAt: string;
  deliveredAt: string | null;
  answeredAt: string | null;
};

export type LoopSuppressionRow = {
  id: string;
  profileId: ProfileId;
  subject: string;
  reason: string;
  createdAt: string;
  liftedAt: string | null;
};

export class StaleOpenLoopRevisionError extends Error {
  constructor(message = "Open loop was modified concurrently; reload it and retry.") {
    super(message);
    this.name = "StaleOpenLoopRevisionError";
  }
}

export type ListOpenLoopsFilter = { statuses?: readonly OpenLoopStatus[] };
export type UpdateOpenLoopPatch = { event: LoopEventKind; dueAt?: string };
export type InsertOpenLoopInput = z.input<typeof createLoopInputSchema> & { profileId: ProfileId };
export type InsertLoopEventInput = {
  loopId: string;
  kind: LoopEventKind;
  detail?: string | null;
  actor?: LoopEventActor;
  sourceThreadId?: string | null;
  sourceMessageId?: string | null;
  agentRunId?: string | null;
  metadata?: Json;
};
export type InsertScheduledCheckInput = { loopId: string; dueAt: string; deliveryId?: string | null };
export type InsertLoopSuppressionInput = { subject: string; reason?: string };

export const DEFAULT_SUPPRESSION_REASON = "User asked Iris to stop following up";

export function normalizeSuppressionSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, " ").toLowerCase();
}

export type AccountabilityRepository = {
  listOpenLoops(profileId: ProfileId, filter?: ListOpenLoopsFilter): Promise<OpenLoopRow[]>;
  getOpenLoop(profileId: ProfileId, loopId: string): Promise<OpenLoopRow | null>;
  insertOpenLoop(input: InsertOpenLoopInput): Promise<OpenLoopRow>;
  updateOpenLoopStatus(profileId: ProfileId, loopId: string, expectedUpdatedAt: string, patch: UpdateOpenLoopPatch): Promise<OpenLoopRow>;
  insertLoopEvent(profileId: ProfileId, input: InsertLoopEventInput): Promise<LoopEventRow>;
  listDueChecks(profileId: ProfileId, nowIso: string, limit: number): Promise<ScheduledCheckRow[]>;
  listDueChecksWithLoops(profileId: ProfileId, nowIso: string, limit: number): Promise<DeliverableDueCheck[]>;
  claimDueChecks(profileId: ProfileId, nowIso: string, limit: number): Promise<DeliverableDueCheck[]>;
  releaseClaims(profileId: ProfileId, checkIds: readonly string[]): Promise<void>;
  markCheckDelivered(profileId: ProfileId, checkId: string, input: MarkCheckDeliveredInput): Promise<ScheduledCheckRow>;
  insertScheduledCheck(profileId: ProfileId, input: InsertScheduledCheckInput): Promise<ScheduledCheckRow>;
  cancelPendingChecksForLoop(profileId: ProfileId, loopId: string, reason: string): Promise<number>;
  cancelOrphanPendingDeliveries(profileId: ProfileId, nowIso: string): Promise<number>;
  insertDelivery(profileId: ProfileId, input: { threadId: string }): Promise<CheckinDeliveryRow>;
  markDeliveryDelivered(profileId: ProfileId, deliveryId: string, input: { messageId: string; deliveredAt?: string }): Promise<CheckinDeliveryRow>;
  insertLoopSuppression(profileId: ProfileId, input: InsertLoopSuppressionInput): Promise<LoopSuppressionRow>;
  liftLoopSuppression(profileId: ProfileId, subject: string): Promise<number>;
  listActiveSuppressions(profileId: ProfileId): Promise<LoopSuppressionRow[]>;
};

const OPEN_LOOP_COLUMNS = "id, profile_id, title, details, kind, status, due_at, cadence, origin_thread_id, origin_message_id, created_at, updated_at, closed_at";
const LOOP_EVENT_COLUMNS = "id, profile_id, loop_id, kind, detail, actor, source_thread_id, source_message_id, agent_run_id, metadata, created_at";
const SCHEDULED_CHECK_COLUMNS = "id, profile_id, loop_id, due_at, status, attempt_count, escalation_tier, delivery_id, delivered_at, cancelled_at, cancel_reason, claimed_at, created_at";
const CHECKIN_DELIVERY_COLUMNS = "id, profile_id, thread_id, message_id, summary, status, created_at, delivered_at, answered_at";
const LOOP_SUPPRESSION_COLUMNS = "id, profile_id, subject, reason, created_at, lifted_at";

const MAX_LOOP_EVENT_DETAIL_LENGTH = 2_000;
const MAX_CANCEL_REASON_LENGTH = 500;
const MAX_SUPPRESSION_REASON_LENGTH = 500;
const CLAIM_STALE_WINDOW_MS = 10 * 60_000;
const ORPHAN_DELIVERY_WINDOW_MS = 30 * 60_000;
const ORPHAN_DELIVERY_REASON = "sweep_retry";

function assertProfileId(value: unknown): asserts value is ProfileId {
  if (!isProfileId(value)) throw new Error("A valid profile scope is required.");
}

function validateLoopEventDetail(detail: string | null | undefined): string | null {
  if (detail === undefined || detail === null) return null;
  if (detail.length > MAX_LOOP_EVENT_DETAIL_LENGTH) {
    throw new Error("Loop event details are limited to 2,000 characters.");
  }
  return detail;
}

function validateCancelReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized || normalized.length > MAX_CANCEL_REASON_LENGTH) {
    throw new Error("Cancel reasons must be between 1 and 500 characters.");
  }
  return normalized;
}

function validateSuppressionSubject(subject: string): string {
  const normalized = normalizeSuppressionSubject(subject);
  if (normalized.length < 2 || normalized.length > 200) {
    throw new Error("Suppression subjects must be between 2 and 200 characters.");
  }
  return normalized;
}

function validateSuppressionReason(reason: string | undefined): string {
  if (reason === undefined || reason === null) return DEFAULT_SUPPRESSION_REASON;
  const normalized = reason.trim();
  if (!normalized || normalized.length > MAX_SUPPRESSION_REASON_LENGTH) {
    throw new Error("Suppression reasons must be between 1 and 500 characters.");
  }
  return normalized;
}

function toOpenLoop(row: OpenLoopTableRow): OpenLoopRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title,
    details: row.details,
    kind: row.kind,
    status: row.status,
    dueAt: row.due_at,
    cadence: (row.cadence ?? null) as Cadence | null,
    originThreadId: row.origin_thread_id,
    originMessageId: row.origin_message_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
  };
}

function toLoopEvent(row: LoopEventTableRow): LoopEventRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    loopId: row.loop_id,
    kind: row.kind,
    detail: row.detail,
    actor: row.actor,
    sourceThreadId: row.source_thread_id,
    sourceMessageId: row.source_message_id,
    agentRunId: row.agent_run_id,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function toScheduledCheck(row: ScheduledCheckTableRow): ScheduledCheckRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    loopId: row.loop_id,
    dueAt: row.due_at,
    status: row.status,
    attemptCount: row.attempt_count,
    escalationTier: row.escalation_tier,
    deliveryId: row.delivery_id,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    claimedAt: row.claimed_at ?? null,
    createdAt: row.created_at,
  };
}

function toDelivery(row: CheckinDeliveryTableRow): CheckinDeliveryRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    summary: row.summary,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
    answeredAt: row.answered_at,
  };
}

function toLoopSuppression(row: LoopSuppressionTableRow): LoopSuppressionRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    subject: row.subject,
    reason: row.reason,
    createdAt: row.created_at,
    liftedAt: row.lifted_at,
  };
}

async function fetchOpenLoop(client: AccountabilityDatabase, profileId: ProfileId, loopId: string): Promise<OpenLoopRow | null> {
  const { data, error } = await client.from("open_loops").select(OPEN_LOOP_COLUMNS).eq("id", loopId).eq("profile_id", profileId).maybeSingle();
  if (error) throw error;
  return data ? toOpenLoop(data) : null;
}

async function fetchPendingDueChecks(client: AccountabilityDatabase, profileId: ProfileId, nowIso: string, limit: number): Promise<ScheduledCheckRow[]> {
  assertProfileId(profileId);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Scheduled check limits must be positive integers.");
  const { data, error } = await client
    .from("scheduled_checks")
    .select(SCHEDULED_CHECK_COLUMNS)
    .eq("profile_id", profileId)
    .eq("status", "pending")
    .lte("due_at", nowIso)
    .order("due_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(toScheduledCheck);
}

async function joinChecksWithLoops(client: AccountabilityDatabase, profileId: ProfileId, checks: ScheduledCheckRow[]): Promise<DeliverableDueCheck[]> {
  if (checks.length === 0) return [];
  const loopIds = [...new Set(checks.map((check) => check.loopId))];
  const { data, error } = await client
    .from("open_loops")
    .select(OPEN_LOOP_COLUMNS)
    .eq("profile_id", profileId)
    .in("id", loopIds);
  if (error) throw error;
  const loopsById = new Map((data ?? []).map((row) => [row.id, toOpenLoop(row)]));
  const joined: DeliverableDueCheck[] = [];
  for (const check of checks) {
    const loop = loopsById.get(check.loopId);
    if (loop) joined.push({ check, loop });
  }
  return joined;
}

export function createProductionAccountabilityRepository(): AccountabilityRepository {
  return createAccountabilityRepository(getDatabase());
}

export function createAccountabilityRepository(client: AccountabilityDatabase = getDatabase()): AccountabilityRepository {
  return {
    async listOpenLoops(profileId, filter = {}) {
      assertProfileId(profileId);
      let request = client.from("open_loops").select(OPEN_LOOP_COLUMNS).eq("profile_id", profileId);
      if (filter.statuses) request = request.in("status", [...filter.statuses]);
      const { data, error } = await request.order("updated_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(toOpenLoop);
    },

    async getOpenLoop(profileId, loopId) {
      assertProfileId(profileId);
      return fetchOpenLoop(client, profileId, loopId);
    },

    async insertOpenLoop(input) {
      assertProfileId(input.profileId);
      const validated = createLoopInputSchema.parse(input);
      const { data, error } = await client
        .from("open_loops")
        .insert({
          profile_id: input.profileId,
          title: validated.title,
          details: validated.details ?? null,
          kind: validated.kind,
          due_at: validated.dueAt ?? null,
          cadence: (validated.cadence ?? null) as Json | null,
        })
        .select(OPEN_LOOP_COLUMNS)
        .single();
      if (error) throw error;
      if (!data) throw new Error("Open loop insert returned no row.");
      return toOpenLoop(data);
    },

    async updateOpenLoopStatus(profileId, loopId, expectedUpdatedAt, patch) {
      assertProfileId(profileId);
      const current = await fetchOpenLoop(client, profileId, loopId);
      if (!current) throw new Error(`Open loop "${loopId}" was not found.`);
      if (current.updatedAt !== expectedUpdatedAt) {
        throw new StaleOpenLoopRevisionError(`Open loop "${loopId}" changed since it was read (expected updated_at ${expectedUpdatedAt}, found ${current.updatedAt}).`);
      }
      const nextStatus = nextStatusOnEvent(current.status, patch.event);
      if (!nextStatus) throw new Error(`Illegal open loop transition: event "${patch.event}" is not allowed from status "${current.status}".`);
      const updatedAt = new Date().toISOString();
      const { data, error } = await client
        .from("open_loops")
        .update({ status: nextStatus, updated_at: updatedAt, closed_at: isTerminal(nextStatus) ? updatedAt : null, ...(patch.dueAt === undefined ? {} : { due_at: patch.dueAt }) })
        .eq("id", loopId)
        .eq("profile_id", profileId)
        .eq("updated_at", expectedUpdatedAt)
        .select(OPEN_LOOP_COLUMNS);
      if (error) throw error;
      const row = (data ?? [])[0];
      if (!row) throw new StaleOpenLoopRevisionError(`Open loop "${loopId}" was updated concurrently.`);
      return toOpenLoop(row);
    },

    async insertLoopEvent(profileId, input) {
      assertProfileId(profileId);
      const detail = validateLoopEventDetail(input.detail);
      const { data, error } = await client
        .from("loop_events")
        .insert({
          profile_id: profileId,
          loop_id: input.loopId,
          kind: input.kind,
          detail,
          actor: input.actor ?? "agent",
          source_thread_id: input.sourceThreadId ?? null,
          source_message_id: input.sourceMessageId ?? null,
          agent_run_id: input.agentRunId ?? null,
          metadata: input.metadata ?? {},
        })
        .select(LOOP_EVENT_COLUMNS)
        .single();
      if (error) throw error;
      if (!data) throw new Error("Loop event insert returned no row.");
      return toLoopEvent(data);
    },

    async listDueChecks(profileId, nowIso, limit) {
      return fetchPendingDueChecks(client, profileId, nowIso, limit);
    },

    async listDueChecksWithLoops(profileId, nowIso, limit) {
      const checks = await fetchPendingDueChecks(client, profileId, nowIso, limit);
      return joinChecksWithLoops(client, profileId, checks);
    },

    async claimDueChecks(profileId, nowIso, limit) {
      assertProfileId(profileId);
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Scheduled check limits must be positive integers.");
      const staleBeforeIso = new Date(Date.parse(nowIso) - CLAIM_STALE_WINDOW_MS).toISOString();
      const { data, error } = await client.rpc("claim_accountability_checks", {
        p_profile_id: profileId,
        p_now: nowIso,
        p_stale_before: staleBeforeIso,
        p_limit: limit,
      });
      if (error) throw error;
      const claimed = (data ?? []).map(toScheduledCheck).sort((left, right) => left.dueAt.localeCompare(right.dueAt));
      return joinChecksWithLoops(client, profileId, claimed);
    },

    async releaseClaims(profileId, checkIds) {
      assertProfileId(profileId);
      if (checkIds.length === 0) return;
      const { error } = await client
        .from("scheduled_checks")
        .update({ claimed_at: null })
        .eq("profile_id", profileId)
        .in("id", [...checkIds]);
      if (error) throw error;
    },

    async markCheckDelivered(profileId, checkId, input) {
      assertProfileId(profileId);
      const { data, error } = await client
        .from("scheduled_checks")
        .update({
          status: "delivered",
          delivery_id: input.deliveryId,
          delivered_at: input.deliveredAt,
          attempt_count: input.attemptCount,
          escalation_tier: input.escalationTier,
          claimed_at: null,
        })
        .eq("id", checkId)
        .eq("profile_id", profileId)
        .eq("status", "pending")
        .select(SCHEDULED_CHECK_COLUMNS);
      if (error) throw error;
      const row = (data ?? [])[0];
      if (!row) throw new Error(`Scheduled check "${checkId}" was not pending for this profile.`);
      return toScheduledCheck(row);
    },

    async insertScheduledCheck(profileId, input) {
      assertProfileId(profileId);
      const { data: priorChecks, error: priorError } = await client
        .from("scheduled_checks")
        .select(SCHEDULED_CHECK_COLUMNS)
        .eq("profile_id", profileId)
        .eq("loop_id", input.loopId);
      if (priorError) throw priorError;
      const carriedAttempts = Math.max(0, ...(priorChecks ?? []).map((row) => row.attempt_count));
      const { data, error } = await client
        .from("scheduled_checks")
        .insert({
          profile_id: profileId,
          loop_id: input.loopId,
          due_at: input.dueAt,
          delivery_id: input.deliveryId ?? null,
          attempt_count: carriedAttempts,
          escalation_tier: Math.min(carriedAttempts, 5),
        })
        .select(SCHEDULED_CHECK_COLUMNS)
        .single();
      if (error) throw error;
      if (!data) throw new Error("Scheduled check insert returned no row.");
      return toScheduledCheck(data);
    },

    async cancelPendingChecksForLoop(profileId, loopId, reason) {
      assertProfileId(profileId);
      const cancelReason = validateCancelReason(reason);
      const { data, error } = await client
        .from("scheduled_checks")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: cancelReason, claimed_at: null })
        .eq("profile_id", profileId)
        .eq("loop_id", loopId)
        .eq("status", "pending")
        .select(SCHEDULED_CHECK_COLUMNS);
      if (error) throw error;
      return (data ?? []).length;
    },

    async cancelOrphanPendingDeliveries(profileId, nowIso) {
      assertProfileId(profileId);
      const cutoffIso = new Date(Date.parse(nowIso) - ORPHAN_DELIVERY_WINDOW_MS).toISOString();
      const { data, error } = await client
        .from("checkin_deliveries")
        .update({ status: "cancelled", summary: ORPHAN_DELIVERY_REASON })
        .eq("profile_id", profileId)
        .eq("status", "pending")
        .is("message_id", null)
        .lt("created_at", cutoffIso)
        .select(CHECKIN_DELIVERY_COLUMNS);
      if (error) throw error;
      return (data ?? []).length;
    },

    async insertDelivery(profileId, input) {
      assertProfileId(profileId);
      const { data, error } = await client
        .from("checkin_deliveries")
        .insert({ profile_id: profileId, thread_id: input.threadId })
        .select(CHECKIN_DELIVERY_COLUMNS)
        .single();
      if (error) throw error;
      if (!data) throw new Error("Check-in delivery insert returned no row.");
      return toDelivery(data);
    },

    async markDeliveryDelivered(profileId, deliveryId, input) {
      assertProfileId(profileId);
      const { data, error } = await client
        .from("checkin_deliveries")
        .update({
          status: "delivered",
          message_id: input.messageId,
          delivered_at: input.deliveredAt ?? new Date().toISOString(),
        })
        .eq("id", deliveryId)
        .eq("profile_id", profileId)
        .eq("status", "pending")
        .select(CHECKIN_DELIVERY_COLUMNS);
      if (error) throw error;
      const row = (data ?? [])[0];
      if (!row) throw new Error(`Check-in delivery "${deliveryId}" was not pending for this profile.`);
      return toDelivery(row);
    },

    async insertLoopSuppression(profileId, input) {
      assertProfileId(profileId);
      const subject = validateSuppressionSubject(input.subject);
      const reason = validateSuppressionReason(input.reason);
      const activeQuery = () =>
        client.from("loop_suppressions").select(LOOP_SUPPRESSION_COLUMNS).eq("profile_id", profileId).eq("subject", subject).is("lifted_at", null);
      const { data: conflicts, error: conflictError } = await activeQuery();
      if (conflictError) throw conflictError;
      const conflict = (conflicts ?? [])[0];
      if (conflict) {
        const { data, error } = await client
          .from("loop_suppressions")
          .update({ reason })
          .eq("id", conflict.id)
          .eq("profile_id", profileId)
          .is("lifted_at", null)
          .select(LOOP_SUPPRESSION_COLUMNS);
        if (error) throw error;
        const updated = (data ?? [])[0];
        if (!updated) throw new Error(`Loop suppression "${conflict.id}" was lifted concurrently.`);
        return toLoopSuppression(updated);
      }
      const { data, error } = await client
        .from("loop_suppressions")
        .insert({ profile_id: profileId, subject, reason })
        .select(LOOP_SUPPRESSION_COLUMNS)
        .single();
      if (error) throw error;
      if (!data) throw new Error("Loop suppression insert returned no row.");
      return toLoopSuppression(data);
    },

    async liftLoopSuppression(profileId, subject) {
      assertProfileId(profileId);
      const normalized = validateSuppressionSubject(subject);
      const { data, error } = await client
        .from("loop_suppressions")
        .update({ lifted_at: new Date().toISOString() })
        .eq("profile_id", profileId)
        .eq("subject", normalized)
        .is("lifted_at", null)
        .select("id");
      if (error) throw error;
      return (data ?? []).length;
    },

    async listActiveSuppressions(profileId) {
      assertProfileId(profileId);
      const { data, error } = await client
        .from("loop_suppressions")
        .select(LOOP_SUPPRESSION_COLUMNS)
        .eq("profile_id", profileId)
        .is("lifted_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []).map(toLoopSuppression);
    },
  };
}
