import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const route = readFileSync(new URL("../../../app/api/threads/[threadId]/messages/route.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../../../supabase/migrations/20260828000000_atomic_existing_thread_turn.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("./governance-repository.ts", import.meta.url), "utf8");

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

  it("lets a pending consolidation job see later committed thread messages", () => {
    expect(repository).not.toContain('.eq("agent_run_id", sourceRunId)');
    expect(repository).toContain('.eq("thread_id", threadId)');
    expect(repository).toContain('.eq("is_complete", true)');
    expect(repository).toContain('.order("created_at", { ascending: false })');
  });
});
