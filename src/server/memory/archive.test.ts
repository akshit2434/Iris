import { describe, expect, it, vi } from "vitest";
import { createMemoryArchiveService } from "@/server/memory/archive";
import type { MemoryStore } from "@/server/memory/types";

const ids = {
  thread: "00000000-0000-4000-8000-000000000011",
  message: "00000000-0000-4000-8000-000000000010",
  run: "00000000-0000-4000-8000-000000000012",
};

function makeStore(documentRevision = 2): MemoryStore {
  return {
    listDocuments: vi.fn(async () => []),
    getDocument: vi.fn(async () => ({ id: "doc", profileId: "profile-a" as const, logicalKey: "PROFILE.md", contentMarkdown: "# Profile", documentRevision, contentHash: "a".repeat(64), createdAt: "now", updatedAt: "now", archivedAt: null })),
    getCurrentRevision: vi.fn(async () => 2),
    applyDocumentRevision: vi.fn(async (input) => ({ profileId: input.profileId, documentId: "doc", documentRevision: 3, profileGlobalRevision: 3, revisionId: "rev", provenanceId: "prov" })),
    searchMessages: vi.fn(async () => []),
    readMessageContext: vi.fn(async () => ({ thread: { id: ids.thread, profileId: "profile-a" as const, title: "Chat", createdAt: "now", updatedAt: "now" }, target: { messageId: ids.message, threadId: ids.thread, profileId: "profile-a" as const, role: "user" as const, content: "forget it", createdAt: "now" }, before: [], after: [] })),
    searchDocuments: vi.fn(async () => []),
  };
}

describe("governed memory archive", () => {
  it("archives only through active message provenance and the expected revision", async () => {
    const store = makeStore();
    const result = await createMemoryArchiveService(store).archive({ profileId: "profile-a", threadId: ids.thread, currentUserMessageId: ids.message, agentRunId: ids.run, toolCallId: "call-1", logicalKey: "PROFILE.md", expectedDocumentRevision: 2, reason: "No longer current" });
    expect(result).toMatchObject({ status: "applied", logicalKey: "PROFILE.md" });
    expect(store.applyDocumentRevision).toHaveBeenCalledWith(expect.objectContaining({ mutationKind: "archive", expectedDocumentRevision: 2, contentMarkdown: "# Profile" }));
  });

  it("returns stale without mutating when the revision changed", async () => {
    const store = makeStore(3);
    const result = await createMemoryArchiveService(store).archive({ profileId: "profile-a", threadId: ids.thread, currentUserMessageId: ids.message, agentRunId: ids.run, toolCallId: "call-1", logicalKey: "PROFILE.md", expectedDocumentRevision: 2 });
    expect(result.status).toBe("stale");
    expect(store.applyDocumentRevision).not.toHaveBeenCalled();
  });
});
