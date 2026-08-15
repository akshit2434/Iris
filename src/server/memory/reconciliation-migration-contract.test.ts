import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const migration = readFileSync("supabase/migrations/20260819000000_memory_reconciliation_compaction.sql", "utf8").toLowerCase();

describe("memory reconciliation migration contract", () => {
  it("keeps raw history, profile/thread ownership, and fresh-thread baselines", () => {
    expect(migration).toContain("memory_revision_seen");
    expect(migration).toContain("threads_context_after_insert");
    expect(migration).toContain("select new.id, new.profile_id, coalesce(s.current_revision, 0)");
    expect(migration).toContain("foreign key (compacted_through_message_id, profile_id, thread_id)");
    expect(migration).toContain("thread_compaction_jobs_run_fkey");
    expect(migration).toContain("for update skip locked");
    expect(migration).not.toContain("delete from public.messages");
    expect(migration).not.toContain("update public.messages");
  });

  it("provides optimistic checkpointing and replay-safe queue identity", () => {
    expect(migration).toContain("unique (profile_id, source_run_id)");
    expect(migration).toContain("unique (profile_id, idempotency_key)");
    expect(migration).toContain("continuity_revision = job_row.expected_continuity_revision");
    expect(migration).toContain("apply_thread_compaction_checkpoint");
    expect(migration).toContain("advance_thread_memory_revision_seen");
  });
});
