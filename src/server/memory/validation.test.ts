import { describe, expect, it } from "vitest";
import { MemorySafetyRejection, validateApplyMemoryItemRevision, validateEmbedding, validateMemoryContentSafety, validateProvenance } from "@/server/memory/validation";

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

  it("rejects secrets, one-time codes, transient observations, role-play, and weak psychological inference", () => {
    const rejected: Array<[string, string]> = [
      ["Remember my api key: sk-live-12345678901234567890", "credential_or_secret"],
      ["My verification code is 123456", "one_time_code"],
      ["I feel overwhelmed today", "transient_mood"],
      ["I am currently at the airport", "transient_location"],
      ["Pretend I am a wizard for this scenario", "role_play"],
      ["You probably have ADHD", "speculative_psychology"],
      ["My friend Arun's phone number is 555-0100", "third_party_sensitive_data"],
    ];
    for (const [content, code] of rejected) {
      expect(() => validateMemoryContentSafety(content)).toThrow(MemorySafetyRejection);
      try { validateMemoryContentSafety(content); } catch (error) { expect(error).toMatchObject({ code }); }
    }
    expect(validateMemoryContentSafety("I prefer concise technical answers.")).toBe("I prefer concise technical answers.");
  });

  it("accepts typed provenance relations without allowing unknown values", () => {
    expect(validateProvenance({ sourceKind: "message", sourceThreadId: "00000000-0000-4000-8000-000000000001", sourceMessageId: "00000000-0000-4000-8000-000000000002", relation: "corrects" })).toMatchObject({ relation: "corrects" });
    expect(() => validateProvenance({ sourceKind: "manual", relation: "unknown" as never })).toThrow("relation");
  });
});
