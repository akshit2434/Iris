import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../../../supabase/migrations/20260818000000_memory_governance.sql", import.meta.url), "utf8").toLowerCase();

describe("memory governance migration contract", () => {
  it("defines idempotent revisions, leased jobs, proposals, and ownership constraints", () => {
    for (const required of [
      "add column if not exists idempotency_key",
      "memory_item_revisions_profile_idempotency_idx",
      "create table if not exists public.memory_consolidation_jobs",
      "unique (profile_id, source_run_id)",
      "foreign key (source_run_id, profile_id, thread_id)",
      "create table if not exists public.memory_mutation_proposals",
      "unique (job_id, proposal_index)",
      "unique (profile_id, idempotency_key)",
      "validate_memory_proposal_sources",
      "source_message_ids uuid[]",
      "source_message_ids', to_jsonb(proposal.source_message_ids)",
      "preserve every source message",
      "'relation', case when proposal.mutation_kind = 'supersede'",
    ]) expect(migration).toContain(required);
  });

  it("keeps worker operations bounded, leased, server-only, and atomically governed", () => {
    for (const required of [
      "for update skip locked",
      "claim_memory_consolidation_jobs",
      "finish_memory_consolidation_job",
      "apply_memory_mutation_proposal",
      "alter table public.memory_consolidation_jobs enable row level security",
      "revoke all on table public.memory_mutation_proposals from public, anon, authenticated",
    ]) expect(migration).toContain(required);
  });
});
