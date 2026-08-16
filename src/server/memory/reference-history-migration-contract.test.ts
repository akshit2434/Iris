import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260823000000_reference_history.sql", import.meta.url), "utf8").toLowerCase();

describe("reference-history migration contract", () => {
  it("defines a derived, versioned, token-watermarked profile layer", () => {
    for (const required of [
      "create type public.reference_history_status",
      "create table if not exists public.profile_memory_settings",
      "saved_memory_enabled boolean",
      "reference_history_enabled boolean",
      "create table if not exists public.profile_reference_history_state",
      "last_processed_token_watermark",
      "create table if not exists public.profile_reference_history_snapshots",
      "source_ranges jsonb",
      "covered_token_watermark",
      "source_hash",
      "memory_revision",
      "synthesizer_version",
      "create table if not exists public.reference_history_jobs",
      "unique (profile_id, idempotency_key)",
      "rebuild_from_raw",
    ]) expect(migration).toContain(required);
  });

  it("keeps worker operations profile-scoped, leased, and service-only", () => {
    for (const required of [
      "foreign key (previous_snapshot_id, profile_id)",
      "foreign key (source_run_id, profile_id)",
      "for update skip locked",
      "create or replace function public.enqueue_reference_history_job",
      "create or replace function public.apply_reference_history_snapshot",
      "create or replace function public.invalidate_reference_history_snapshot",
      "alter table public.reference_history_jobs enable row level security",
      "revoke all on table public.profile_reference_history_snapshots from public, anon, authenticated",
      "grant execute on function public.claim_reference_history_jobs",
    ]) expect(migration).toContain(required);
  });

  it("does not use message-count thresholds or persist raw prompts", () => {
    expect(migration).not.toContain("message_count");
    expect(migration).not.toContain("prompt text");
    expect(migration).not.toContain("raw_prompt");
  });
});
