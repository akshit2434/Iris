import { describe, expect, it } from "vitest";
import { measureScrollFollowState, returnToBottomState } from "@/lib/chat-scroll";

describe("chat scroll follow state", () => {
  it("follows while near the bottom", () => {
    expect(measureScrollFollowState({ scrollHeight: 1000, scrollTop: 780, clientHeight: 100 })).toEqual({ nearBottom: true, manual: false, follow: true });
  });

  it("locks follow mode when the user scrolls meaningfully upward", () => {
    expect(measureScrollFollowState({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 })).toEqual({ nearBottom: false, manual: true, follow: false });
  });

  it("re-enables follow mode when the user returns to the bottom", () => {
    expect(returnToBottomState()).toEqual({ nearBottom: true, manual: false, follow: true });
  });
});
