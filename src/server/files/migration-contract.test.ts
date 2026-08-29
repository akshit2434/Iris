import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Database } from "@/server/db/types";
import { buildStoragePath, MAX_FILE_BYTES } from "@/server/files/repository";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260902000000_files.sql", import.meta.url),
  "utf8",
);

describe("private files migration contract", () => {
  it("defines profile-scoped metadata and a private storage bucket", () => {
    for (const required of [
      "create type public.file_record_kind as enum ('upload', 'artifact')",
      "create table if not exists public.files",
      "profile_id text not null references public.profiles(id) on delete cascade",
      "foreign key (source_thread_id, profile_id)",
      "foreign key (source_message_id, profile_id, source_thread_id)",
      "alter table public.files enable row level security",
      "revoke all on table public.files from public, anon, authenticated",
      "insert into storage.buckets",
      "values ('iris-files', 'iris-files', false, 52428800)",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("keeps storage paths inside the profile namespace", () => {
    expect(buildStoragePath("profile-a", "file-id", "notes/plan.txt")).toBe("profile-a/file-id/notes_plan.txt");
    expect(buildStoragePath("profile-b", "file-id", "   ")).toBe("profile-b/file-id/untitled-file");
    expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
  });

  it("exposes file metadata in database types", () => {
    const files: keyof Database["public"]["Tables"] = "files";
    expect(files).toBe("files");
  });
});
