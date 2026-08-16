import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../../../app/api/threads/[threadId]/messages/route.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../supabase/migrations/20260828000000_atomic_existing_thread_turn.sql", import.meta.url), "utf8");
const rangeMigration = readFileSync(new URL("../../../supabase/migrations/20260828100000_memory_consolidation_ranges.sql", import.meta.url), "utf8");
const atomicTurnFixMigration = readFileSync(new URL("../../../supabase/migrations/20260828200000_fix_atomic_existing_thread_turn.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("./governance-repository.ts", import.meta.url), "utf8");
const consolidation = readFileSync(new URL("./consolidation.ts", import.meta.url), "utf8");

describe("memory reliability integration contract", () => {
  it("keeps automatic retrieval internal while preserving model tool events", () => {
    expect(route).not.toContain('toolName: "memory_context"');
    expect(route).not.toContain('toolName: "history_preflight"');
    expect(route).toContain('event.type === "tool_started"');
    expect(route).toContain('type: "tool_call"');
    expect(route).toContain('savedMemoryEnabled: memoryControls.savedMemoryEnabled');
    expect(route).toContain('referenceHistoryEnabled: memoryControls.referenceHistoryEnabled');
  });

  it("creates existing-thread runs and user messages in one transaction", () => {
    expect(migration).toContain("create or replace function public.create_run_with_user_message");
    expect(migration).toContain("insert into public.messages");
    expect(migration).toContain("insert into public.agent_runs");
    expect(migration).toContain("update public.messages set agent_run_id");
  });

  it("qualifies returned-column names inside the existing-thread RPC", () => {
    expect(atomicTurnFixMigration).toContain("update public.messages m set agent_run_id = p_run_id");
    expect(atomicTurnFixMigration).toContain("where m.id = p_user_message_id and m.profile_id = p_profile_id and m.thread_id = p_thread_id");
  });

  it("lets a pending consolidation job see later committed thread messages", () => {
    expect(repository).toContain('database.rpc("list_memory_consolidation_job_messages"');
    expect(consolidation).toContain("options.governanceStore.listJobMessages(job, MAX_SOURCE_MESSAGES)");
    expect(rangeMigration).toContain("source_start_token_total");
    expect(rangeMigration).toContain("last_processed_token_total");
    expect(rangeMigration).toContain("source_start := least(state.last_processed_token_total, source_total)");
    expect(rangeMigration).toContain("o.token_end > j.source_start_token_total");
    expect(rangeMigration).toContain("o.token_end - o.token_count < j.source_token_total");
    expect(rangeMigration).toContain("create or replace function public.claim_memory_consolidation_job");
    expect(rangeMigration).toContain("set last_processed_token_total = greatest");
    expect(route).toContain("createProductionConsolidationWorker({ job: consolidationJob");
  });
});
