import { describe, expect, it } from "vitest";
import { deriveThreadTitle, normalizeThreadTitle } from "@/lib/thread-title";
import { resolveThreadTitle } from "@/server/agent/title";

describe("thread title helpers", () => {
  it("normalizes provider formatting into a short plain title", () => {
    expect(normalizeThreadTitle('Title: **Plan a focused study sprint!**', "Fallback title")).toBe("Plan a focused study sprint");
    expect(normalizeThreadTitle("One", "A useful fallback title")).toBe("A useful fallback title");
  });

  it("derives a deterministic six-word fallback without punctuation", () => {
    expect(deriveThreadTitle("Plan my exam schedule for next week, please!")).toBe("Plan my exam schedule for next");
    expect(deriveThreadTitle("   ")).toBe("New chat");
  });

  it("uses an injected generator and never calls a provider in the test", async () => {
    const generator = async () => '"Build a gentle morning routine."';
    await expect(resolveThreadTitle({ request: "Help me design a gentle morning routine", generator })).resolves.toBe("Build a gentle morning routine");
  });

  it("falls back on a controlled timeout while aborting the generator", async () => {
    let aborted = false;
    const generator = async (_request: string, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener("abort", () => { aborted = true; });
      return new Promise<string>(() => undefined);
    };
    await expect(resolveThreadTitle({ request: "Prepare my weekly review", generator, timeoutMs: 5 })).resolves.toBe("Prepare my weekly review");
    expect(aborted).toBe(true);
  });
});
