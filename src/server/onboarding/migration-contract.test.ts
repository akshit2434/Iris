import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260904100000_onboarding_profiles.sql", import.meta.url), "utf8");

describe("onboarding migration contract", () => {
  it("keeps lightweight onboarding state profile-scoped and server-owned", () => {
    expect(migration).toContain("create table if not exists public.onboarding_profiles");
    expect(migration).toContain("profile_id text primary key references public.profiles(id) on delete cascade");
    expect(migration).toContain("confirmed_timezone text");
    expect(migration).toContain("alter table public.onboarding_profiles enable row level security");
    expect(migration).toContain("revoke all on table public.onboarding_profiles from public, anon, authenticated");
  });
});
