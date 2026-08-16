import { describe, expect, it } from "vitest";
import { buildOpenMessageAction, buildOpenMessageHref, memoryItemRows, memorySourceRows, validateOpenMessageAction } from "@/lib/memory-source";

const action = {
  type: "open_message",
  threadId: "00000000-0000-4000-8000-000000000011",
  messageId: "00000000-0000-4000-8000-000000000010",
  label: "Open source",
} as const;

describe("memory source actions", () => {
  it("builds only validated internal message links", () => {
    expect(validateOpenMessageAction(action)).toEqual(action);
    expect(buildOpenMessageHref(action)).toBe("/chat/00000000-0000-4000-8000-000000000011#message-00000000-0000-4000-8000-000000000010");
    expect(validateOpenMessageAction({ ...action, label: "https://example.com" })).toBeNull();
    expect(validateOpenMessageAction({ ...action, threadId: "not-a-uuid" })).toBeNull();
    expect(buildOpenMessageHref({ threadId: "https://example.com", messageId: action.messageId })).toBeNull();
  });

  it("bounds and filters structured historical results", () => {
    const rows = memorySourceRows("search_messages", {
      kind: "message_search",
      results: [
        { action, profileId: "profile-a", excerpt: "A useful prior decision", createdAt: "2026-08-14T12:00:00.000Z", role: "user" },
        { action: { ...action, label: "javascript:bad" }, profileId: "profile-a", excerpt: "Do not render", createdAt: "2026-08-14T12:00:00.000Z" },
        { action, profileId: "profile-b", excerpt: "Wrong profile", createdAt: "2026-08-14T12:00:00.000Z" },
      ],
    }, "profile-a");
    expect(rows).toEqual([{ action, profileId: "profile-a", excerpt: "A useful prior decision", createdAt: "2026-08-14T12:00:00.000Z", role: "user" }]);
  });

  it("rebuilds a missing search action only from the hit's internal IDs", () => {
    expect(buildOpenMessageAction(action.threadId, action.messageId)).toEqual(action);
    expect(memorySourceRows("search_messages", {
      kind: "message_search",
      results: [{ profileId: "profile-a", threadId: action.threadId, messageId: action.messageId, excerpt: "Legacy search hit", createdAt: "2026-08-14T12:00:00.000Z" }],
    }, "profile-a")).toEqual([{ action, profileId: "profile-a", excerpt: "Legacy search hit", createdAt: "2026-08-14T12:00:00.000Z" }]);
    expect(memorySourceRows("search_messages", {
      kind: "message_search",
      results: [{ profileId: "profile-b", threadId: action.threadId, messageId: action.messageId, excerpt: "Foreign hit", createdAt: "2026-08-14T12:00:00.000Z" }],
    }, "profile-a")).toEqual([]);
    expect(buildOpenMessageAction("not-a-uuid", action.messageId)).toBeNull();
  });

  it("replays deterministic preflight sources as internal message actions", () => {
    expect(memorySourceRows("history_preflight", {
      kind: "history_preflight",
      status: "found",
      sources: [{ profileId: "profile-a", threadId: action.threadId, messageId: action.messageId, action, excerpt: "A retained source", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Decision" }],
    }, "profile-a")).toEqual([{ action, profileId: "profile-a", excerpt: "A retained source", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Decision" }]);
  });

  it("projects every canonical-memory provenance candidate as a separate source card", () => {
    const secondAction = { ...action, messageId: "00000000-0000-4000-8000-000000000012" };
    expect(memorySourceRows("memory_search", {
      kind: "memory_search",
      results: [{
        canonicalKey: "profile.machine",
        excerpt: "Current machine",
        sources: [
          { action, profileId: "profile-a", excerpt: "My machine is a LunarBook 14.", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Machine note" },
          { action: secondAction, profileId: "profile-a", excerpt: "I use it for work.", createdAt: "2026-08-15T12:00:00.000Z", role: "user", threadTitle: "Work setup" },
        ],
      }],
    }, "profile-a")).toEqual([
      { action, profileId: "profile-a", excerpt: "My machine is a LunarBook 14.", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Machine note" },
      { action: secondAction, profileId: "profile-a", excerpt: "I use it for work.", createdAt: "2026-08-15T12:00:00.000Z", role: "user", threadTitle: "Work setup" },
    ]);
  });

  it("projects provenance nested under an exact memory read", () => {
    expect(memorySourceRows("memory_read", {
      kind: "memory_read",
      item: { canonicalKey: "profile.machine", sources: [{ action, profileId: "profile-a", excerpt: "My machine is a LunarBook 14.", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Machine note" }] },
    }, "profile-a")).toEqual([{ action, profileId: "profile-a", excerpt: "My machine is a LunarBook 14.", createdAt: "2026-08-14T12:00:00.000Z", role: "user", threadTitle: "Machine note" }]);
  });

  it("renders structured memory item tool results without document-era fields", () => {
    expect(memoryItemRows("memory_read", {
      kind: "memory_read",
      found: true,
      item: { canonicalKey: "profile.communication", itemRevision: 3, category: "preference", updatedAt: "2026-08-16T12:00:00.000Z", content: "The user prefers concise answers." },
    })).toEqual([{ canonicalKey: "profile.communication", itemRevision: 3, category: "preference", updatedAt: "2026-08-16T12:00:00.000Z", excerpt: "The user prefers concise answers." }]);
    expect(memoryItemRows("memory_list", {
      kind: "memory_list",
      results: [{ canonicalKey: "profile.communication", itemRevision: 3, category: "preference", updatedAt: "2026-08-16T12:00:00.000Z", excerpt: "The user prefers concise answers." }],
    })).toHaveLength(1);
    expect(memoryItemRows("memory_read", { kind: "memory_read", item: { canonicalKey: "", itemRevision: "3", updatedAt: "2026-08-16T12:00:00.000Z", content: "invalid" } })).toEqual([]);
  });
});
