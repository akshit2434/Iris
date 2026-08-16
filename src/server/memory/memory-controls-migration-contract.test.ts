import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260825000000_memory_controls_derived_cleanup.sql", import.meta.url), "utf8").toLowerCase();

describe("memory controls cleanup contract", () => {
  it("clears replaceable derived layers without deleting raw chats", () => {
    expect(migration).toContain("create or replace function public.clear_reference_history_data");
    expect(migration).toContain("delete from public.message_semantic_index");
    expect(migration).toContain("thread_continuity_checkpoints");
    expect(migration).toContain("update public.thread_context");
    expect(migration).not.toContain("delete from public.messages");
    expect(migration).not.toContain("delete from public.threads");
  });

  it("keeps cleanup profile-scoped and service-only", () => {
    expect(migration).toContain("where profile_id = p_profile_id");
    expect(migration).toContain("revoke all on function public.clear_reference_history_data(text) from public, anon, authenticated");
    expect(migration).toContain("grant execute on function public.clear_reference_history_data(text) to service_role");
  });
});
