import { describe, expect, it } from "vitest";
import { runDeterministicMemoryAcceptance } from "@/server/memory/acceptance";

describe("deterministic memory acceptance harness", () => {
  it("simulates Chat A write, Chat B recall/source, and an old-chat delta", async () => {
    const result = await runDeterministicMemoryAcceptance({
      patchFact: async () => ({ status: "applied", logicalKey: "PROFILE.md", profileGlobalRevision: 2 }),
      readCanonicalFact: async () => ({ logicalKey: "PROFILE.md", contentMarkdown: "# Profile\n\nPrefers concise answers." }),
      searchExactSource: async () => [{ messageId: "00000000-0000-4000-8000-000000000010", threadId: "00000000-0000-4000-8000-000000000011", excerpt: "Please remember this durable fact" }],
      readChanges: async () => [{ logicalKey: "PROFILE.md", mutationKind: "update", documentRevision: 2, profileGlobalRevision: 2, createdAt: "2026-08-18T00:00:00.000Z", archivedAt: null, contentMarkdown: "# Profile", excerpt: "Prefers concise answers." }],
    });
    expect(result.chatA).toMatchObject({ status: "applied", logicalKey: "PROFILE.md" });
    expect(result.chatB).toMatchObject({ recalled: true, exactSourceFound: true, sourceHref: "/chat/00000000-0000-4000-8000-000000000011#message-00000000-0000-4000-8000-000000000010" });
    expect(result.oldChatA.changes[0]?.logicalKey).toBe("PROFILE.md");
  });
});
