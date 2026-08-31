import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chat back navigation affordance", () => {
  it("uses an accessible vector icon instead of a text arrow", () => {
    const source = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain('aria-label="Back to history"');
    expect(source).toContain('viewBox="0 0 24 24"');
    expect(source).toContain('strokeLinecap="round"');
    expect(source).not.toContain('aria-label="Back to history">←</');
  });

  it("keeps one chat surface mounted while a provisional route is promoted", () => {
    const source = readFileSync(new URL("../components/app-shell.tsx", import.meta.url), "utf8");
    expect(source).toContain("{inChat ? <ChatScreen /> : children}");
  });

  it("invalidates old stream state when the persistent chat surface changes route", () => {
    const source = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain("activeRequestRef.current?.abort()");
    expect(source).toContain("streamGenerationRef.current += 1");
    expect(source).toContain("streamBufferRef.current?.cancel()");
    expect(source).toContain("isConfirmedNewChatPromotion");
  });

  it("keeps the chat surface mounted behind its loading transition", () => {
    const source = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain("if (!loading && !thread && !isNewChat && !hasMessages)");
    expect(source).toContain("ChatLoadingOverlay");
  });

  it("keeps the chat scroll surface shrinkable and full-width inside its flex parent", () => {
    const source = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
    expect(source).toContain('className="iris-scrollbar min-w-0 w-full flex-1 overflow-y-auto');
  });
});
