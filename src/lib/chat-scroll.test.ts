import { describe, expect, it } from "vitest";
import { createBottomScrollScheduler, measureScrollFollowState, returnToBottomState } from "@/lib/chat-scroll";

describe("chat scroll follow state", () => {
  it("follows while near the bottom", () => {
    expect(measureScrollFollowState({ scrollHeight: 1000, scrollTop: 780, clientHeight: 100 })).toEqual({ nearBottom: true, manual: false, follow: true });
  });

  it("locks follow mode when the user scrolls meaningfully upward", () => {
    expect(measureScrollFollowState({ scrollHeight: 1000, scrollTop: 500, clientHeight: 100 })).toEqual({ nearBottom: false, manual: true, follow: false });
  });

  it("re-enables follow mode when the user returns to the bottom", () => {
    expect(returnToBottomState()).toEqual({ nearBottom: true, manual: false, follow: true });
  });

  it("coalesces streamed updates into a smooth bottom-follow request", () => {
    let clock = 0;
    const scheduled: Array<() => void> = [];
    const motions: string[] = [];
    const scheduler = createBottomScrollScheduler({
      intervalMs: 120,
      now: () => clock,
      schedule: (callback) => { scheduled.push(callback); return callback; },
      cancel: () => undefined,
    });

    scheduler.request(() => true, (motion) => motions.push(motion));
    scheduler.request(() => true, (motion) => motions.push(motion));
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(motions).toEqual(["smooth"]);

    clock = 40;
    scheduler.request(() => true, (motion) => motions.push(motion));
    expect(scheduled).toHaveLength(2);
    expect(motions).toEqual(["smooth"]);
  });

  it("drops a queued follow when the user scrolls upward and honors reduced motion", () => {
    const scheduled: Array<() => void> = [];
    const motions: string[] = [];
    const scheduler = createBottomScrollScheduler({
      reducedMotion: () => true,
      schedule: (callback) => { scheduled.push(callback); return callback; },
      cancel: () => undefined,
    });

    scheduler.request(() => false, (motion) => motions.push(motion));
    scheduled[0]();
    expect(motions).toEqual([]);

    scheduler.request(() => true, (motion) => motions.push(motion));
    scheduled[1]();
    expect(motions).toEqual(["auto"]);
  });

  it("cancels a queued request without leaving a stale scroll writer", () => {
    const scheduled: Array<() => void> = [];
    const motions: string[] = [];
    const scheduler = createBottomScrollScheduler({
      schedule: (callback) => { scheduled.push(callback); return callback; },
      cancel: () => undefined,
    });

    scheduler.request(() => true, (motion) => motions.push(motion));
    scheduler.cancel();
    scheduled[0]();
    expect(motions).toEqual([]);
  });
});
