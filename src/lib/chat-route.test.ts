import { describe, expect, it } from "vitest";
import { isConfirmedNewChatPromotion, isNewChatPromotion, isPersistedThreadId, isUnsavedChatPath, messageEndpointForThread, UNSAVED_CHAT_ID } from "@/lib/chat-route";

describe("lazy chat routes", () => {
  it("recognizes the unsaved route without treating a persisted chat as new", () => {
    expect(isUnsavedChatPath("/chat/new")).toBe(true);
    expect(isUnsavedChatPath("/chat/00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(UNSAVED_CHAT_ID).toBe("new");
  });

  it("posts the first message to the dedicated endpoint and never creates a blank thread endpoint", () => {
    expect(messageEndpointForThread(UNSAVED_CHAT_ID)).toBe("/api/threads/new/messages");
    expect(messageEndpointForThread("00000000-0000-4000-8000-000000000001")).toBe("/api/threads/00000000-0000-4000-8000-000000000001/messages");
  });

  it("accepts only UUID-shaped persisted route IDs", () => {
    expect(isPersistedThreadId("00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isPersistedThreadId("new")).toBe(false);
    expect(isPersistedThreadId(null)).toBe(false);
  });

  it("recognizes only the provisional-to-persisted promotion", () => {
    expect(isNewChatPromotion("new", "00000000-0000-4000-8000-000000000001")).toBe(true);
    expect(isNewChatPromotion("00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002")).toBe(false);
    expect(isNewChatPromotion("new", "not-a-thread")).toBe(false);
  });

  it("only preserves provisional state for the thread created by the request", () => {
    const created = "00000000-0000-4000-8000-000000000001";
    const unrelated = "00000000-0000-4000-8000-000000000002";
    expect(isConfirmedNewChatPromotion("new", created, created)).toBe(true);
    expect(isConfirmedNewChatPromotion("new", unrelated, created)).toBe(false);
    expect(isConfirmedNewChatPromotion("new", created, null)).toBe(false);
  });
});
