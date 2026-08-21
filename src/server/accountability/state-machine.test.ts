import { describe, expect, it } from "vitest";
import { isTerminal, nextStatusOnEvent } from "./state-machine";
import { LOOP_EVENT_KINDS, createLoopInputSchema } from "./types";

describe("accountability state machine", () => {
  it("closes loops only through closing events", () => {
    expect(nextStatusOnEvent("open", "completed")).toBe("done");
    expect(nextStatusOnEvent("open", "dropped")).toBe("dropped");
    expect(nextStatusOnEvent("paused", "completed")).toBe("done");
  });

  it("keeps non-status events on the current status", () => {
    expect(nextStatusOnEvent("open", "nudged")).toBe("open");
    expect(nextStatusOnEvent("open", "rescheduled")).toBe("open");
    expect(nextStatusOnEvent("open", "note")).toBe("open");
  });

  it("pauses and resumes", () => {
    expect(nextStatusOnEvent("open", "paused")).toBe("paused");
    expect(nextStatusOnEvent("paused", "resumed")).toBe("open");
    expect(nextStatusOnEvent("done", "resumed")).toBeNull();
  });

  it("allows reopening paused loops directly", () => {
    expect(nextStatusOnEvent("paused", "reopened")).toBe("open");
  });

  it("allows reopening terminal loops and nothing else leaves terminals implicitly", () => {
    expect(nextStatusOnEvent("done", "reopened")).toBe("open");
    expect(nextStatusOnEvent("cancelled", "reopened")).toBe("open");
    expect(nextStatusOnEvent("done", "completed")).toBeNull();
    expect(nextStatusOnEvent("dropped", "nudged")).toBeNull();
  });

  it("flags terminal statuses", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("open")).toBe(false);
  });
});

describe("loop event kinds", () => {
  it("mirrors the SQL enum values in order", () => {
    expect([...LOOP_EVENT_KINDS]).toEqual([
      "created",
      "clarified",
      "rescheduled",
      "paused",
      "resumed",
      "nudged",
      "completed",
      "cancelled",
      "dropped",
      "reopened",
      "suppressed",
      "note",
    ]);
  });
});

describe("createLoopInputSchema", () => {
  it("requires cadence exactly for routine loops", () => {
    expect(createLoopInputSchema.safeParse({ title: "x", kind: "routine" }).success).toBe(false);
    expect(
      createLoopInputSchema.safeParse({ title: "x", kind: "routine", cadence: { kind: "daily" } }).success,
    ).toBe(true);
    expect(
      createLoopInputSchema.safeParse({ title: "x", kind: "commitment", cadence: { kind: "daily" } }).success,
    ).toBe(false);
    expect(createLoopInputSchema.safeParse({ title: "x" }).success).toBe(true);
    expect(createLoopInputSchema.safeParse({ title: "" }).success).toBe(false);
  });
});
