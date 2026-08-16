import { describe, expect, it } from "vitest";
import { buildOpenMessageAction, buildOpenMessageHref, memorySourceRows, validateOpenMessageAction } from "@/lib/memory-source";

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
});
