import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260820000000_lazy_chat_persistence.sql", import.meta.url), "utf8");

describe("lazy chat persistence migration", () => {
  it("creates the first message, run, and ownership link in one function", () => {
    expect(migration).toContain("create_thread_with_first_message");
    expect(migration).toContain("insert into public.threads");
    expect(migration).toContain("insert into public.messages");
    expect(migration).toContain("insert into public.agent_runs");
    expect(migration).toContain("set agent_run_id = p_run_id");
    expect(migration).toContain("pg_advisory_xact_lock");
  });

  it("rejects blank input, scopes retries by profile/request, and keeps the RPC server-only", () => {
    expect(migration).toContain("char_length(btrim(p_content)) = 0");
    expect(migration).toContain("r.profile_id = p_profile_id and r.request_id = btrim(p_request_id)");
    expect(migration).toContain("revoke all on function public.create_thread_with_first_message");
    expect(migration).toContain("grant execute on function public.create_thread_with_first_message");
  });
});
