import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20260819000000_memory_reconciliation_compaction.sql", "utf8").toLowerCase();

describe("token continuity migration contract", () => {
  it("keeps immutable raw history and creates versioned structured checkpoints", () => {
    expect(migration).toContain("thread_continuity_checkpoints");
    expect(migration).toContain("document jsonb not null");
    expect(migration).toContain("source_message_ids uuid[]");
    expect(migration).toContain("source_estimated_tokens integer");
    expect(migration).toContain("summarizer_version text");
    expect(migration).toContain("input_hash text");
    expect(migration).toContain("foreign key (covered_through_message_id, profile_id, thread_id)");
    expect(migration).not.toContain("delete from public.messages");
    expect(migration).not.toContain("update public.messages");
  });

  it("queues from serialized token thresholds with optimistic stale protection", () => {
    expect(migration).toContain("thread_continuity_jobs");
    expect(migration).toContain("p_projected_input_tokens * 4 < p_safe_input_budget_tokens * 3");
    expect(migration).toContain("expected_continuity_revision");
    expect(migration).toContain("for update skip locked");
    expect(migration).toContain("apply_thread_continuity_checkpoint");
    expect(migration).toContain("invalidate_thread_continuity_checkpoint");
    expect(migration).not.toContain("min_messages");
    expect(migration).not.toContain("recent_tail_messages");
    expect(migration).not.toContain("message_count");
  });
});
