import { describe, expect, it } from "vitest";
import { validateApplyMemoryItemRevision, validateEmbedding, validateProvenance } from "@/server/memory/validation";

const base = { profileId: "profile-a" as const, canonicalKey: "profile.communication", content: "The user prefers concise answers.", status: "active" as const, mutationKind: "update" as const };

describe("structured memory request validation", () => {
  it("requires a profile, natural content, safe canonical key, and non-stale revision", () => {
    expect(validateApplyMemoryItemRevision(base)).toMatchObject({ canonicalKey: "profile.communication", content: base.content });
    expect(() => validateApplyMemoryItemRevision({ ...base, profileId: "profile-other" as never })).toThrow("valid profile scope");
    expect(() => validateApplyMemoryItemRevision({ ...base, content: "" })).toThrow("non-empty natural language");
    expect(() => validateApplyMemoryItemRevision({ ...base, canonicalKey: "../secrets" })).toThrow("short safe identifiers");
    expect(() => validateApplyMemoryItemRevision({ ...base, expectedItemRevision: -1 })).toThrow("non-negative integer");
  });

  it("requires strongly shaped provenance without inventing message sources", () => {
    expect(() => validateProvenance({ sourceKind: "message" })).toThrow("message and thread");
    expect(() => validateProvenance({ sourceKind: "manual", sourceMessageId: "id" })).toThrow("cannot claim");
    expect(validateProvenance({ sourceKind: "manual" })).toEqual({ sourceKind: "manual" });
  });

  it("requires exactly 1536 finite embedding values", () => {
    expect(() => validateEmbedding([])).toThrow("1536");
    expect(() => validateEmbedding(Array.from({ length: 1536 }, () => Number.NaN))).toThrow("finite");
    expect(validateEmbedding(Array.from({ length: 1536 }, () => 0))).toHaveLength(1536);
  });
});
