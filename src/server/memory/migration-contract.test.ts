import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260817000000_memory_foundation.sql", import.meta.url), "utf8");

describe("memory foundation migration contract", () => {
  it("defines canonical, immutable, provenance, derived, and profile-state layers", () => {
    for (const required of [
      "create extension if not exists vector",
      "create table if not exists public.profile_memory_state",
      "create table if not exists public.memory_documents",
      "create table if not exists public.memory_document_revisions",
      "create table if not exists public.memory_provenance",
      "create table if not exists public.message_semantic_index",
      "generated always as (to_tsvector",
      "using gin(search_vector)",
      "using hnsw (embedding extensions.vector_cosine_ops)",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("keeps ownership and RPC safety predicates explicit", () => {
    for (const required of [
      "foreign key (document_id, profile_id)",
      "foreign key (source_message_id, profile_id, source_thread_id)",
      "foreign key (source_agent_event_id, profile_id, source_thread_id, source_agent_run_id)",
      "alter table public.memory_documents enable row level security",
      "revoke all on table public.memory_documents from public, anon, authenticated",
      "create or replace function public.search_messages",
      "m.profile_id = p_profile_id",
      "p_query_embedding is null",
      "create or replace function public.apply_memory_document_revision",
      "for update",
      "raise exception 'Stale canonical memory document revision'",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });
});
