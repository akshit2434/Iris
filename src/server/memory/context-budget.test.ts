import { describe, expect, it } from "vitest";
import { budgetCanonicalMemory, formatCanonicalMemoryPrompt } from "@/server/memory/context-budget";
import type { CanonicalMemoryDocument } from "@/server/memory/types";

function document(logicalKey: string, contentMarkdown: string, updatedAt: string, profileId: "profile-a" | "profile-b" = "profile-a", archivedAt: string | null = null): CanonicalMemoryDocument {
  return {
    id: `${logicalKey}-id`,
    profileId,
    logicalKey,
    contentMarkdown,
    documentRevision: 1,
    contentHash: "a".repeat(64),
    createdAt: updatedAt,
    updatedAt,
    archivedAt,
  };
}

describe("canonical memory context budget", () => {
  it("prioritizes PROFILE/CURRENT and caps documents and characters deterministically", () => {
    const memory = budgetCanonicalMemory([
      document("z.md", "z".repeat(30), "2026-08-03T00:00:00.000Z"),
      document("CURRENT.md", "current", "2026-08-01T00:00:00.000Z"),
      document("PROFILE.md", "profile", "2026-08-01T00:00:00.000Z"),
      document("archived.md", "ignore", "2026-08-04T00:00:00.000Z", "profile-a", "2026-08-04T00:00:00.000Z"),
    ], 7, { maxDocuments: 3, maxCharacters: 15 });
    expect(memory.globalRevision).toBe(7);
    expect(memory.documents.map((item) => item.logicalKey)).toEqual(["PROFILE.md", "CURRENT.md", "z.md"]);
    expect(memory.documents.map((item) => item.contentMarkdown).join("")).toHaveLength(15);
    expect(formatCanonicalMemoryPrompt(memory)).toContain('<canonical-memory global-revision="7">');
  });

  it("adds no prompt noise when memory is empty and never accepts another profile", () => {
    const memory = budgetCanonicalMemory([
      document("foreign.md", "foreign", "2026-08-01T00:00:00.000Z", "profile-b"),
    ], 0, { maxDocuments: 8, profileId: "profile-a" });
    expect(memory.documents).toEqual([]);
    expect(formatCanonicalMemoryPrompt(memory)).toBe("");
  });
});
