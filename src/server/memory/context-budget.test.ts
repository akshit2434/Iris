import { describe, expect, it } from "vitest";
import { budgetCanonicalMemory, formatCanonicalMemoryPrompt } from "@/server/memory/context-budget";
import type { MemoryItem } from "@/server/memory/types";

function item(canonicalKey: string, content: string, updatedAt: string, profileId: "profile-a" | "profile-b" = "profile-a", status: MemoryItem["status"] = "active"): MemoryItem {
  return { id: `${canonicalKey}-id`, profileId, canonicalKey, content, itemRevision: 1, category: canonicalKey.includes("instruction") ? "instruction" : canonicalKey.includes("focus") ? "active_state" : "preference", valueScope: "single", origin: "explicit", confidence: 1, importance: 0.5, sensitivity: "normal", status, validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, createdAt: updatedAt, updatedAt, archivedAt: status === "archived" ? updatedAt : null, deletedAt: status === "deleted" ? updatedAt : null };
}

describe("structured memory context budget", () => {
  it("prioritizes instructions and caps items and characters deterministically", () => {
    const memory = budgetCanonicalMemory([
      item("z.preference", "z12345", "2026-08-15T00:00:00.000Z"),
      item("profile.preference", "profile", "2026-08-15T00:00:00.000Z"),
      item("focus.active", "focus", "2026-08-14T00:00:00.000Z"),
      item("instruction.style", "style", "2026-08-13T00:00:00.000Z"),
    ], 7, { maxItems: 3, maxCharacters: 15 });
    expect(memory.items.map((entry) => entry.canonicalKey)).toEqual(["instruction.style", "profile.preference", "z.preference"]);
    expect(memory.items.map((entry) => entry.content).join("")).toHaveLength(15);
    expect(formatCanonicalMemoryPrompt(memory)).toContain("<saved-memory global-revision=\"7\">");
  });

  it("filters other profiles and inactive items", () => {
    const memory = budgetCanonicalMemory([item("a", "A", "now"), item("b", "B", "now", "profile-b"), item("c", "C", "now", "profile-a", "archived")], 1, { profileId: "profile-a" });
    expect(memory.items).toHaveLength(1);
    expect(memory.items[0]?.canonicalKey).toBe("a");
  });
});
