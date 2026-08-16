import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260823100000_historical_search_contract.sql", import.meta.url), "utf8").toLowerCase();

describe("historical search migration contract", () => {
  it("defines the bounded exact, hybrid, semantic, date, role, and profile-scoped search contract", () => {
    for (const required of [
      "create or replace function public.search_messages_v2",
      "p_exact_phrase",
      "p_match_type",
      "p_roles",
      "p_from timestamptz",
      "p_to timestamptz",
      "m.profile_id = p_profile_id",
      "m.role = any(p_roles)",
      "effective_match = 'exact_phrase'",
      "effective_match = 'semantic'",
      "grant execute on function public.search_messages_v2",
    ]) expect(migration).toContain(required);
  });
});
