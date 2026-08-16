import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260817000000_memory_foundation.sql", import.meta.url), "utf8");

describe("memory foundation migration contract", () => {
  it("defines canonical, immutable, provenance, derived, and profile-state layers", () => {
    for (const required of [
      "create extension if not exists vector",
      "create table if not exists public.profile_memory_state",
      "create type public.memory_item_category",
      "create table if not exists public.memory_items",
      "create table if not exists public.memory_item_revisions",
      "create table if not exists public.memory_item_sources",
      "create table if not exists public.memory_suppressions",
      "prevent_memory_item_revision_mutation",
      "memory_item_revisions_immutable",
      "memory_item_sources_immutable",
      "create table if not exists public.message_semantic_index",
      "generated always as (to_tsvector",
      "using gin(search_vector)",
      "using hnsw (embedding extensions.vector_cosine_ops)",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("keeps ownership and RPC safety predicates explicit", () => {
    for (const required of [
      "foreign key (item_id, profile_id)",
      "foreign key (source_message_id, profile_id, source_thread_id)",
      "foreign key (source_agent_event_id, profile_id, source_thread_id, source_agent_run_id)",
      "alter table public.memory_items enable row level security",
      "revoke all on table public.memory_items from public, anon, authenticated",
      "create or replace function public.search_messages",
      "m.profile_id = p_profile_id",
      "p_query_embedding is null",
      "create or replace function public.apply_memory_item_revision",
      "for update",
      "raise exception 'Stale memory item revision'",
      "memory_items_profile_single_active_idx",
      "if p_status = 'archived' then",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });
});
