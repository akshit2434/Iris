import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260822000000_memory_lifecycle.sql", import.meta.url), "utf8").toLowerCase();

describe("governed memory lifecycle migration contract", () => {
  it("uses a per-thread serialized-token watermark and idle debounce", () => {
    expect(migration).toContain("memory_consolidation_state");
    expect(migration).toContain("last_enqueued_token_total");
    expect(migration).toContain("source_token_total");
    expect(migration).toContain("source_total < state.last_enqueued_token_total + 1200");
    expect(migration).toContain("p_idle_signal");
    expect(migration).toContain("p_debounce_seconds");
    expect(migration).not.toContain("message_count");
    expect(migration).not.toContain("min_messages");
  });

  it("keeps profile/thread ownership and service-only RPC access", () => {
    expect(migration).toContain("foreign key (thread_id, profile_id)");
    expect(migration).toContain("foreign key (last_source_run_id, profile_id, thread_id)");
    expect(migration).toContain("for update");
    expect(migration).toContain("revoke all on table public.memory_consolidation_state from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.enqueue_memory_consolidation_job");
  });
});
