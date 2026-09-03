import { describe, expect, it } from "vitest";
import { nextCheckDecision, nextLocalDaylightCheck } from "./scheduling-policy";

describe("accountability scheduling policy", () => {
  it("uses cadence for routines and bounded backoff for ignored commitments", () => {
    expect(nextCheckDecision({ kind: "routine", cadence: { kind: "weekly" }, priorAttempts: 0, nowIso: "2026-09-03T09:00:00.000Z" }))
      .toEqual({ dueAt: "2026-09-10T09:00:00.000Z" });
    expect(nextCheckDecision({ kind: "commitment", cadence: null, priorAttempts: 2, nowIso: "2026-09-03T09:00:00.000Z" }))
      .toEqual({ dueAt: "2026-09-07T09:00:00.000Z" });
    expect(nextCheckDecision({ kind: "commitment", cadence: null, priorAttempts: 4, nowIso: "2026-09-03T09:00:00.000Z" }))
      .toEqual({ dueAt: null, reason: "max_attempts" });
  });

  it("moves Not today from now, not a stale overdue date", () => {
    expect(nextLocalDaylightCheck("2026-09-03T11:30:00.000Z", "2026-08-01T10:00:00.000Z"))
      .toBe("2026-09-04T10:00:00.000Z");
  });
});
