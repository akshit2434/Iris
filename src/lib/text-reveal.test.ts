import { describe, expect, it } from "vitest";
import { createTextRevealScheduler } from "@/lib/text-reveal";

function hasUnpairedSurrogate(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function controlledScheduler(options: { immediate?: boolean } = {}) {
  const scheduled: Array<{ callback: () => void; delay: number }> = [];
  const revealed: string[] = [];
  let completed = 0;
  const scheduler = createTextRevealScheduler({
    ...options,
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    cancel: () => undefined,
    onReveal: (text) => revealed.push(text),
    onComplete: () => { completed += 1; },
  });
  return { scheduler, scheduled, revealed, get completed() { return completed; } };
}

describe("text reveal scheduler", () => {
  it("drains a burst over multiple natural ticks instead of terminal-flushing", () => {
    const controlled = controlledScheduler();
    controlled.scheduler.push("One two");
    controlled.scheduler.push("One two three. Four five six.");
    controlled.scheduler.end();
    expect(controlled.revealed).toEqual([]);
    expect(controlled.scheduled.length).toBe(1);

    controlled.scheduled.shift()?.callback();
    expect(controlled.revealed.length).toBe(1);
    expect(controlled.revealed[0].length).toBeLessThan("One two three. Four five six.".length);
    expect(controlled.completed).toBe(0);
    while (controlled.scheduled.length > 0) controlled.scheduled.shift()?.callback();
    expect(controlled.revealed.at(-1)).toBe("One two three. Four five six.");
    expect(controlled.completed).toBe(1);
  });

  it("keeps every reveal monotonic and preserves Unicode graphemes", () => {
    const controlled = controlledScheduler();
    const canonical = "🙂 café — 東京。\nNext line.";
    controlled.scheduler.push(canonical);
    controlled.scheduler.end();
    while (controlled.scheduled.length > 0) controlled.scheduled.shift()?.callback();
    expect(controlled.revealed.at(-1)).toBe(canonical);
    for (let index = 1; index < controlled.revealed.length; index += 1) {
      expect(canonical.startsWith(controlled.revealed[index])).toBe(true);
      expect(controlled.revealed[index].length).toBeGreaterThan(controlled.revealed[index - 1].length);
    }
    expect(controlled.revealed.some(hasUnpairedSurrogate)).toBe(false);
  });

  it("uses bounded adaptive catch-up and never loses later updates", () => {
    const controlled = controlledScheduler();
    controlled.scheduler.push("word ".repeat(200));
    controlled.scheduler.end();
    expect(controlled.scheduled[0]?.delay).toBeGreaterThanOrEqual(25);
    expect(controlled.scheduled[0]?.delay).toBeLessThanOrEqual(45);
    controlled.scheduled.shift()?.callback();
    expect(controlled.revealed[0].length).toBeLessThan(200 * 5);
    while (controlled.scheduled.length > 0) controlled.scheduled.shift()?.callback();
    expect(controlled.revealed.at(-1)).toBe("word ".repeat(200));
  });

  it("supports reduced-motion immediate mode and cancels stale work", () => {
    const immediate = controlledScheduler({ immediate: true });
    immediate.scheduler.push("**Immediate**");
    immediate.scheduler.end();
    expect(immediate.revealed).toEqual(["**Immediate**"]);
    expect(immediate.completed).toBe(1);

    const cancelled = controlledScheduler();
    cancelled.scheduler.push("This should never be shown");
    cancelled.scheduler.cancel();
    cancelled.scheduled.shift()?.callback();
    expect(cancelled.revealed).toEqual([]);
    expect(cancelled.completed).toBe(0);
  });

  it("resets safely when a new canonical message replaces the prior prefix", () => {
    const controlled = controlledScheduler();
    controlled.scheduler.push("old response");
    controlled.scheduler.end();
    controlled.scheduled.shift()?.callback();
    controlled.scheduler.push("new response");
    controlled.scheduler.end();
    while (controlled.scheduled.length > 0) controlled.scheduled.shift()?.callback();
    expect(controlled.revealed.at(-1)).toBe("new response");
  });
});
