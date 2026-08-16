import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("memory upgrade reconciliation migration", () => {
  it("retains legacy data while rebuilding the current runtime shape", async () => {
    const migration = await readFile(
      resolve(process.cwd(), "supabase/migrations/20260826000000_memory_upgrade_reconciliation.sql"),
      "utf8",
    );

    expect(migration).toContain("memory_mutation_proposals_legacy");
    expect(migration).toContain("memory_migration_markers");
    expect(migration).toContain("memory_items");
    expect(migration).toContain("memory_item_revisions");
    expect(migration).toContain("memory_item_sources");
    expect(migration).toContain("thread_continuity_checkpoints");
    expect(migration).toContain("thread_continuity_jobs");
    expect(migration).toContain("structured-memory-v1");
    expect(migration).toContain("memory_documents");
  });
});
