import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("exact historical source UX contract", () => {
  const chat = readFileSync(new URL("../components/chat-screen.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../../app/api/threads/[threadId]/messages/[messageId]/route.ts", import.meta.url), "utf8");
  const prompt = readFileSync(new URL("../server/agent/context.ts", import.meta.url), "utf8");

  it("renders structured source candidates with user-controlled preview and exact opening", () => {
    expect(chat).toContain("function SourceCard");
    expect(chat).toContain("SourcePreviewDialog");
    expect(chat).toContain("Preview");
    expect(chat).toContain("Open message");
    expect(chat).toContain("formatSourceDate");
    expect(chat).toContain("exact source");
    expect(chat).toContain("scroll={false}");
  });

  it("fetches a bounded surrounding window behind both app-access and profile boundaries", () => {
    expect(route).toContain("await assertAppAccess()");
    expect(route).toContain("await getSelectedProfile()");
    expect(route).toContain("readMessages(profileId, messageId, 3)");
    expect(route).toContain("context.thread.id !== threadId");
    expect(route).toContain("Source message is no longer available.");
  });

  it("keeps automatic retrieval hidden while requiring visible model tools for exact sources", () => {
    expect(prompt).toContain("always use real read-only tools");
    expect(prompt).toContain('set roles=["user"]');
    expect(prompt).toContain('set roles=["assistant"]');
    expect(prompt).toContain("let the user choose Preview or Open message");
    const messageRoute = readFileSync(new URL("../../app/api/threads/[threadId]/messages/route.ts", import.meta.url), "utf8");
    expect(messageRoute).not.toContain('toolName: "history_preflight"');
    expect(messageRoute).not.toContain('toolName: "memory_context"');
    expect(messageRoute).toContain('type: "tool_call"');
    expect(messageRoute).toContain('type: "tool_result"');
  });

  it("contains no product-specific source-selection workaround", () => {
    const implementation = [chat, prompt, readFileSync(new URL("../server/memory/history-preflight.ts", import.meta.url), "utf8")].join("\n");
    expect(implementation).not.toMatch(/macbook|realme|gt\s*7/i);
  });
});
