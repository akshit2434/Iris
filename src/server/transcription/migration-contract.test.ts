import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260903000000_voice_transcriptions.sql", import.meta.url), "utf8");

describe("voice transcription migration contract", () => {
  it("keeps jobs and learned vocabulary profile-scoped and server-owned", () => {
    expect(migration).toContain("'cancelled'");
    expect(migration).toContain("create table if not exists public.voice_transcriptions");
    expect(migration).toContain("profile_id text not null references public.profiles(id) on delete cascade");
    expect(migration).toContain("alter table public.voice_transcriptions enable row level security");
    expect(migration).toContain("revoke all on table public.voice_transcriptions from public, anon, authenticated");
    expect(migration).toContain("create table if not exists public.voice_vocabulary");
    expect(migration).toContain("unique (profile_id, normalized_term)");
  });
});
