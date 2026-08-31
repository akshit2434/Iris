import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("global focus styling", () => {
  it("removes focus outlines and rings from interactive controls", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain(":where(button, a, input, textarea, select, summary, [role=\"button\"], [tabindex]):focus {");
    expect(css).toContain("outline: none;");
    expect(css).toContain("-webkit-tap-highlight-color: transparent");
    expect(css).not.toContain(":focus-visible");
  });
});
