import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260828000000_reference_history_observability.sql", import.meta.url), "utf8").toLowerCase();

describe("reference-history observability migration contract", () => {
  it("scopes background telemetry to profile and job with optional validated links", () => {
    for (const required of [
      "create table if not exists public.reference_history_agent_events",
      "profile_id text not null references public.profiles(id)",
      "job_id uuid not null",
      "unique (profile_id, job_id, sequence)",
      "foreign key (job_id, profile_id)",
      "thread_id uuid",
      "source_run_id uuid",
      "foreign key (thread_id, profile_id)",
      "on delete set null (thread_id)",
      "foreign key (source_run_id, profile_id)",
      "on delete set null (source_run_id)",
      "alter table public.reference_history_agent_events enable row level security",
    ]) expect(migration).toContain(required);
  });

  it("stores lifecycle metadata only and never prompt/raw-history fields", () => {
    expect(migration).toContain("model_call_started");
    expect(migration).toContain("model_call_completed");
    expect(migration).not.toContain("raw_prompt");
    expect(migration).not.toContain("prompt text");
    expect(migration).not.toContain("content text");
  });
});
