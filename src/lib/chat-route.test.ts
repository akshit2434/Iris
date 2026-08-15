import { describe, expect, it } from "vitest";
import { isPersistedThreadId, isUnsavedChatPath, messageEndpointForThread, UNSAVED_CHAT_ID } from "@/lib/chat-route";

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
});
