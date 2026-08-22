import { describe, expect, it } from "vitest";
import {
  BRIEFING_HOUR_UTC,
  BRIEFING_LOOP_TITLE,
  briefingDayWindow,
  hasBlockingBriefingCheck,
  isBriefingLoopTitle,
  nextBriefingDueAt,
} from "@/server/accountability/briefing";

describe("morning briefing scheduling helpers", () => {
  it("reserves one exact loop title", () => {
    expect(BRIEFING_LOOP_TITLE).toBe("Morning briefing");
    expect(isBriefingLoopTitle("Morning briefing")).toBe(true);
    expect(isBriefingLoopTitle("morning briefing")).toBe(false);
    expect(isBriefingLoopTitle("Renew passport")).toBe(false);
  });

  it("targets today's 08:00 while it is still ahead of now", () => {
    expect(nextBriefingDueAt("2026-08-21T06:30:00.000Z")).toBe("2026-08-21T08:00:00.000Z");
    expect(nextBriefingDueAt("2026-08-21T07:59:59.999Z")).toBe("2026-08-21T08:00:00.000Z");
    expect(BRIEFING_HOUR_UTC).toBe(8);
  });

  it("rolls to tomorrow 08:00 once today's slot is past", () => {
    expect(nextBriefingDueAt("2026-08-22T08:30:00.000Z")).toBe("2026-08-23T08:00:00.000Z");
    expect(nextBriefingDueAt("2026-08-22T08:00:00.000Z")).toBe("2026-08-23T08:00:00.000Z");
    expect(nextBriefingDueAt("2026-08-22T23:59:59.999Z")).toBe("2026-08-23T08:00:00.000Z");
  });

  it("rejects invalid times", () => {
    expect(() => nextBriefingDueAt("not-a-time")).toThrow();
    expect(() => briefingDayWindow("not-a-time")).toThrow();
  });

  it("bounds the same-day dedupe window to the day containing now", () => {
    const window = briefingDayWindow("2026-08-22T08:30:00.000Z");
    expect(window.startMs).toBe(Date.parse("2026-08-22T00:00:00.000Z"));
    expect(window.endMs).toBe(Date.parse("2026-08-23T00:00:00.000Z"));
  });

  it("blocks on fresh pending checks and on deliveries marked delivered inside the window only", () => {
    const window = briefingDayWindow("2026-08-22T08:30:00.000Z");
    expect(hasBlockingBriefingCheck([{ status: "pending", deliveredAt: null, dueAt: "2026-08-22T08:00:00.000Z" }], window)).toBe(true);
    expect(hasBlockingBriefingCheck([{ status: "pending", deliveredAt: null, dueAt: "2026-08-23T08:00:00.000Z" }], window)).toBe(true);
    expect(hasBlockingBriefingCheck([{ status: "delivered", deliveredAt: "2026-08-22T08:05:00.000Z", dueAt: "2026-08-22T08:00:00.000Z" }], window)).toBe(true);
    expect(hasBlockingBriefingCheck([{ status: "delivered", deliveredAt: "2026-08-21T09:00:00.000Z", dueAt: "2026-08-21T08:00:00.000Z" }], window)).toBe(false);
    expect(hasBlockingBriefingCheck([{ status: "cancelled", deliveredAt: null, dueAt: "2026-08-22T08:00:00.000Z" }], window)).toBe(false);
    expect(hasBlockingBriefingCheck([{ status: "expired", deliveredAt: null, dueAt: "2026-08-22T08:00:00.000Z" }], window)).toBe(false);
    expect(hasBlockingBriefingCheck([], window)).toBe(false);
  });

  it("treats pending checks left over from earlier days as stale rather than blocking", () => {
    const window = briefingDayWindow("2026-08-22T08:30:00.000Z");
    expect(hasBlockingBriefingCheck([{ status: "pending", deliveredAt: null, dueAt: "2026-08-21T08:00:00.000Z" }], window)).toBe(false);
    expect(hasBlockingBriefingCheck([{ status: "pending", deliveredAt: null, dueAt: "2026-08-22T00:00:00.000Z" }], window)).toBe(true);
  });
});
