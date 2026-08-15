import { describe, expect, it } from "vitest";
import { validateApplyMemoryDocumentRevision, validateEmbedding, validateProvenance } from "@/server/memory/validation";

const base = {
  profileId: "profile-a" as const,
  logicalKey: "CURRENT.md",
  contentMarkdown: "# Current\n\nThe active focus is T1.",
  mutationKind: "update" as const,
};

describe("canonical memory request validation", () => {
  it("requires a profile, natural Markdown, safe logical key, and non-stale expected revision", () => {
    expect(validateApplyMemoryDocumentRevision(base)).toMatchObject({ logicalKey: "CURRENT.md", contentMarkdown: base.contentMarkdown });
    expect(() => validateApplyMemoryDocumentRevision({ ...base, profileId: "profile-other" as never })).toThrow("valid profile scope");
    expect(() => validateApplyMemoryDocumentRevision({ ...base, contentMarkdown: "" })).toThrow("non-empty natural Markdown");
    expect(() => validateApplyMemoryDocumentRevision({ ...base, logicalKey: "../secrets" })).toThrow("safe paths");
    expect(() => validateApplyMemoryDocumentRevision({ ...base, expectedDocumentRevision: -1 })).toThrow("non-negative integer");
  });

  it("requires strongly shaped provenance without inventing message sources", () => {
    expect(validateProvenance({ sourceKind: "manual" })).toEqual({ sourceKind: "manual" });
    expect(() => validateProvenance({ sourceKind: "message", sourceThreadId: "thread-a" })).toThrow("message and thread");
    expect(() => validateProvenance({ sourceKind: "thread" })).toThrow("thread ownership");
    expect(() => validateProvenance({ sourceKind: "agent_event", sourceThreadId: "thread-a", sourceAgentEventId: "event-a" })).toThrow("event, run, and thread");
    expect(() => validateProvenance({ sourceKind: "manual", sourceMessageId: "message-a", sourceThreadId: "thread-a" })).toThrow("cannot claim");
    expect(() => validateProvenance({ sourceKind: "manual", sourceExcerpt: "x".repeat(2_001) })).toThrow("2,000");
  });

  it("requires exactly 1536 finite embedding values", () => {
    expect(() => validateEmbedding([1])).toThrow("exactly 1536");
    expect(() => validateEmbedding(Array.from({ length: 1536 }, () => Number.POSITIVE_INFINITY))).toThrow("finite numbers");
  });
});
