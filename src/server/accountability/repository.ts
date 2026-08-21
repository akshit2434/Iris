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

export type ScheduledCheckStatus = "pending" | "delivered" | "merged" | "cancelled" | "expired";
export type LoopEventActor = "user" | "agent" | "system";

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
  createdAt: string;
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

export type AccountabilityRepository = {
  listOpenLoops(profileId: ProfileId, filter?: ListOpenLoopsFilter): Promise<OpenLoopRow[]>;
  getOpenLoop(profileId: ProfileId, loopId: string): Promise<OpenLoopRow | null>;
  insertOpenLoop(input: InsertOpenLoopInput): Promise<OpenLoopRow>;
  updateOpenLoopStatus(profileId: ProfileId, loopId: string, expectedUpdatedAt: string, patch: UpdateOpenLoopPatch): Promise<OpenLoopRow>;
  insertLoopEvent(profileId: ProfileId, input: InsertLoopEventInput): Promise<LoopEventRow>;
  listDueChecks(profileId: ProfileId, nowIso: string, limit: number): Promise<ScheduledCheckRow[]>;
  insertScheduledCheck(profileId: ProfileId, input: InsertScheduledCheckInput): Promise<ScheduledCheckRow>;
  cancelPendingChecksForLoop(profileId: ProfileId, loopId: string, reason: string): Promise<number>;
};

const OPEN_LOOP_COLUMNS = "id, profile_id, title, details, kind, status, due_at, cadence, origin_thread_id, origin_message_id, created_at, updated_at, closed_at";
const LOOP_EVENT_COLUMNS = "id, profile_id, loop_id, kind, detail, actor, source_thread_id, source_message_id, agent_run_id, metadata, created_at";
const SCHEDULED_CHECK_COLUMNS = "id, profile_id, loop_id, due_at, status, attempt_count, escalation_tier, delivery_id, delivered_at, cancelled_at, cancel_reason, created_at";

const MAX_LOOP_EVENT_DETAIL_LENGTH = 2_000;
const MAX_CANCEL_REASON_LENGTH = 500;

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
    createdAt: row.created_at,
  };
}

async function fetchOpenLoop(client: AccountabilityDatabase, profileId: ProfileId, loopId: string): Promise<OpenLoopRow | null> {
  const { data, error } = await client.from("open_loops").select(OPEN_LOOP_COLUMNS).eq("id", loopId).eq("profile_id", profileId).maybeSingle();
  if (error) throw error;
  return data ? toOpenLoop(data) : null;
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
    },

    async insertScheduledCheck(profileId, input) {
      assertProfileId(profileId);
      const { data, error } = await client
        .from("scheduled_checks")
        .insert({
          profile_id: profileId,
          loop_id: input.loopId,
          due_at: input.dueAt,
          delivery_id: input.deliveryId ?? null,
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
        .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: cancelReason })
        .eq("profile_id", profileId)
        .eq("loop_id", loopId)
        .eq("status", "pending")
        .select(SCHEDULED_CHECK_COLUMNS);
      if (error) throw error;
      return (data ?? []).length;
    },
  };
}
