import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Database } from "@/server/db/types";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260829000000_accountability_foundation.sql", import.meta.url),
  "utf8",
);

describe("accountability foundation migration contract", () => {
  it("defines loop, ledger, schedule, delivery, and suppression layers", () => {
    for (const required of [
      "create type public.open_loop_kind",
      "create type public.open_loop_status",
      "create type public.loop_event_kind",
      "create type public.scheduled_check_status",
      "create type public.checkin_delivery_status",
      "create table if not exists public.open_loops",
      "create table if not exists public.loop_events",
      "create table if not exists public.scheduled_checks",
      "create table if not exists public.checkin_deliveries",
      "create table if not exists public.checkin_delivery_items",
      "create table if not exists public.loop_suppressions",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("keeps person-scoped ownership, immutability, and sweep predicates explicit", () => {
    for (const required of [
      "references public.profiles(id) on delete cascade",
      "foreign key (loop_id, profile_id)",
      "foreign key (delivery_id, profile_id)",
      "foreign key (source_message_id, profile_id, source_thread_id)",
      "prevent_loop_event_mutation",
      "loop_events_immutable",
      "alter table public.open_loops enable row level security",
      "revoke all on table public.open_loops from public, anon, authenticated",
      "where status = 'pending'",
      "kind <> 'routine' or cadence is not null",
      "(status in ('open','paused') and closed_at is null)",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("exposes accountability tables in database types", () => {
    const tables: Array<keyof Database["public"]["Tables"]> = [
      "open_loops",
      "loop_events",
      "checkin_deliveries",
      "checkin_delivery_items",
      "scheduled_checks",
      "loop_suppressions",
    ];
    expect(tables.length).toBe(6);
  });
});
