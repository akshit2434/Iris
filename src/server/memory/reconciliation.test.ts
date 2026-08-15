import { describe, expect, it } from "vitest";
import { collapseMemoryChanges, formatMemoryChangeHint, shouldAdvanceMemoryRevision } from "@/server/memory/reconciliation";

const change = (logicalKey: string, global: number, mutationKind: "create" | "update" | "archive" = "update") => ({
  logicalKey,
  mutationKind,
  documentRevision: global,
  profileGlobalRevision: global,
  createdAt: `2026-08-1${global}T00:00:00.000Z`,
  archivedAt: mutationKind === "archive" ? "2026-08-18T00:00:00.000Z" : null,
  contentMarkdown: `# ${logicalKey} ${global}`,
  excerpt: `Latest ${logicalKey} ${global}`,
});

describe("memory revision reconciliation", () => {
  it("collapses multiple revisions per key and keeps the bounded range", () => {
    const hint = collapseMemoryChanges([change("A.md", 2), change("A.md", 4), change("B.md", 3, "archive")], 1, 4);
    expect(hint.changes.map((item) => [item.logicalKey, item.profileGlobalRevision])).toEqual([["A.md", 4], ["B.md", 3]]);
    expect(formatMemoryChangeHint(hint)).toContain('through="4"');
  });

  it("adds no prompt noise when there is no change", () => {
    expect(formatMemoryChangeHint(collapseMemoryChanges([], 5, 5))).toBe("");
  });

  it("advances only successful captured snapshots", () => {
    expect(shouldAdvanceMemoryRevision({ runStatus: "completed", snapshotRevision: 4, currentRevision: 5 })).toBe(true);
    expect(shouldAdvanceMemoryRevision({ runStatus: "failed", snapshotRevision: 4, currentRevision: 5 })).toBe(false);
    expect(shouldAdvanceMemoryRevision({ runStatus: "completed", snapshotRevision: 6, currentRevision: 5 })).toBe(false);
  });
});
