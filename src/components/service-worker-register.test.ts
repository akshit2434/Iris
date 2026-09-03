import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const worker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");

describe("service worker delivery contract", () => {
  it("opens the exact delivery message without putting notification copy in the URL", () => {
    expect(worker).toContain('self.addEventListener("push"');
    expect(worker).toContain('self.addEventListener("notificationclick"');
    expect(worker).toContain("#message-");
    expect(worker).not.toContain("payload.body}`");
  });
});
