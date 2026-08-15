import { describe, expect, it } from "vitest";
import { messageIdFromHash, resolveMessageHashTarget } from "@/lib/chat-source-navigation";

const messageId = "00000000-0000-4000-8000-000000000001";

describe("historical source hash navigation", () => {
  it("accepts only internal message UUID hashes", () => {
    expect(messageIdFromHash(`#message-${messageId}`)).toBe(messageId);
    expect(messageIdFromHash("#message-not-a-uuid")).toBeNull();
    expect(messageIdFromHash("https://example.com/#message-00000000-0000-4000-8000-000000000001")).toBeNull();
  });

  it("resolves only targets present in the loaded transcript", () => {
    expect(resolveMessageHashTarget(`#message-${messageId}`, [messageId])).toBe(messageId);
    expect(resolveMessageHashTarget(`#message-${messageId}`, [])).toBeNull();
  });
});
