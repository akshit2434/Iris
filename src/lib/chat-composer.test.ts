import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canSubmitMessage } from "@/lib/chat-composer";

describe("chat composer submission guard", () => {
  it("keeps drafts editable while blocking submission during network or visual presentation", () => {
    expect(canSubmitMessage(" next thought ", false, false, true)).toBe(true);
    expect(canSubmitMessage("next thought", true, false, true)).toBe(false);
    expect(canSubmitMessage("next thought", false, true, true)).toBe(false);
    expect(canSubmitMessage("   ", false, false, true)).toBe(false);
    expect(canSubmitMessage("next thought", false, false, false)).toBe(false);
  });

  it("keeps the textarea enabled and gates Enter/button submission separately", () => {
    const source = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("disabled={sending}");
    expect(source).toContain("!sending && !presentationActive");
    expect(source).toContain("presentationActive, Boolean(thread)");
  });
});
