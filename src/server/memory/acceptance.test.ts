import { describe, expect, it } from "vitest";
import { runDeterministicMemoryAcceptance } from "@/server/memory/acceptance";

describe("deterministic memory acceptance harness", () => {
  it("simulates Chat A write, Chat B recall/source, and an old-chat delta", async () => {
    const result = await runDeterministicMemoryAcceptance({
      patchFact: async () => ({ status: "applied", canonicalKey: "profile.communication", profileGlobalRevision: 2 }),
      readCanonicalFact: async () => ({ canonicalKey: "profile.communication", content: "Prefers concise answers." }),
      searchExactSource: async () => [{ messageId: "00000000-0000-4000-8000-000000000010", threadId: "00000000-0000-4000-8000-000000000011", excerpt: "Please remember this durable fact" }],
      readChanges: async () => [{ canonicalKey: "profile.communication", mutationKind: "update", itemRevision: 2, status: "active", profileGlobalRevision: 2, createdAt: "2026-08-18T00:00:00.000Z", content: "Prefers concise answers.", excerpt: "Prefers concise answers." }],
    });
    expect(result.chatA).toMatchObject({ status: "applied", canonicalKey: "profile.communication" });
    expect(result.chatB).toMatchObject({ recalled: true, exactSourceFound: true, sourceHref: "/chat/00000000-0000-4000-8000-000000000011#message-00000000-0000-4000-8000-000000000010" });
    expect(result.oldChatA.changes[0]?.canonicalKey).toBe("profile.communication");
  });
});
