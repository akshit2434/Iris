import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("global focus styling", () => {
  it("keeps pointer reset and keyboard-only custom focus cues centralized", () => {
    const css = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
    expect(css).toContain(":where(button, a, input, textarea, select, summary, [role=\"button\"], [tabindex]):focus {");
    expect(css).toContain(":focus-visible {");
    expect(css).toContain('html[data-input-modality="pointer"]');
    expect(css).toContain("-webkit-tap-highlight-color: transparent");
    expect(css).not.toContain(":focus-visible {\n  outline: 3px");
  });
});
