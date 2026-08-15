import { describe, expect, it, vi } from "vitest";
import { createMemoryMutationService } from "@/server/memory/mutation";
import type { MemoryStore } from "@/server/memory/types";

const base = {
  profileId: "profile-a" as const,
  threadId: "00000000-0000-4000-8000-000000000011",
  currentUserMessageId: "00000000-0000-4000-8000-000000000010",
  agentRunId: "00000000-0000-4000-8000-000000000012",
  toolCallId: "call-memory",
  logicalKey: "PROFILE.md",
  contentMarkdown: "# Profile\n\nThe user prefers concise answers.",
  expectedDocumentRevision: null,
  mutationKind: "create" as const,
};

function store(documents: Awaited<ReturnType<MemoryStore["listDocuments"]>> = []): MemoryStore {
  return {
    listDocuments: vi.fn(async () => documents),
    getDocument: vi.fn(async () => null),
    getCurrentRevision: vi.fn(async () => 0),
    applyDocumentRevision: vi.fn(async (input) => ({ profileId: input.profileId, documentId: "00000000-0000-4000-8000-000000000020", documentRevision: 1, profileGlobalRevision: 1, revisionId: "00000000-0000-4000-8000-000000000021", provenanceId: "00000000-0000-4000-8000-000000000022" })),
    searchMessages: vi.fn(async () => []),
    readMessageContext: vi.fn(async (_profileId, messageId) => messageId === base.currentUserMessageId ? ({
      thread: { id: base.threadId, profileId: "profile-a" as const, title: "Test", createdAt: "now", updatedAt: "now" },
      target: { messageId, threadId: base.threadId, profileId: "profile-a" as const, role: "user" as const, content: "remember", createdAt: "now" },
      before: [], after: [],
    }) : null),
    searchDocuments: vi.fn(async () => []),
  };
}

describe("governed memory mutation", () => {
  it("applies only with current message provenance and a run/tool idempotency key", async () => {
    const memoryStore = store();
    const service = createMemoryMutationService(memoryStore);
    await expect(service.apply(base)).resolves.toMatchObject({ status: "applied", logicalKey: "PROFILE.md" });
    expect(memoryStore.applyDocumentRevision).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: "memory-patch:00000000-0000-4000-8000-000000000012:call-memory",
      provenance: { sourceKind: "message", sourceThreadId: base.threadId, sourceMessageId: base.currentUserMessageId },
    }));
  });

  it("rejects stale revisions, duplicate creates, and oversized content without writing", async () => {
    const existing = [{ id: "doc", profileId: "profile-a" as const, logicalKey: "PROFILE.md", contentMarkdown: "old", documentRevision: 4, contentHash: "a".repeat(64), createdAt: "now", updatedAt: "now", archivedAt: null }];
    const memoryStore = store(existing);
    const service = createMemoryMutationService(memoryStore);
    await expect(service.apply(base)).resolves.toMatchObject({ status: "conflict" });
    await expect(service.apply({ ...base, mutationKind: "update", expectedDocumentRevision: 3 })).resolves.toMatchObject({ status: "stale" });
    await expect(service.apply({ ...base, contentMarkdown: "x".repeat(20_001) })).resolves.toMatchObject({ status: "conflict" });
    expect(memoryStore.applyDocumentRevision).not.toHaveBeenCalled();
  });

  it("does not permit malformed or foreign provenance inputs", async () => {
    const service = createMemoryMutationService(store());
    await expect(service.apply({ ...base, currentUserMessageId: "foreign" })).rejects.toThrow("valid UUID");
    await expect(service.apply({ ...base, currentUserMessageId: "00000000-0000-4000-8000-000000000099" })).resolves.toMatchObject({ status: "conflict" });
  });
});
