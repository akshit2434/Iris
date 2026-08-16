import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDelayedPresenceController,
  DEFAULT_PAGE_LOADER_DELAY_MS,
  DEFAULT_PAGE_LOADER_EXIT_MS,
} from "@/lib/delayed-presence";

describe("delayed presence controller", () => {
  afterEach(() => vi.useRealTimers());

  it("does not show before the delay, then enters and becomes visible", () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const controller = createDelayedPresenceController({ onPhaseChange: (phase) => phases.push(phase) });

    controller.setActive(true);
    vi.advanceTimersByTime(DEFAULT_PAGE_LOADER_DELAY_MS - 1);
    expect(phases).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(phases).toEqual(["entering"]);
    vi.advanceTimersByTime(16);
    expect(phases).toEqual(["entering", "visible"]);
    controller.dispose();
  });

  it("cancels a pending show when disposed", () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const controller = createDelayedPresenceController({ onPhaseChange: (phase) => phases.push(phase) });

    controller.setActive(true);
    controller.dispose();
    vi.advanceTimersByTime(DEFAULT_PAGE_LOADER_DELAY_MS + 100);
    expect(phases).toEqual([]);
  });

  it("exits after content becomes ready", () => {
    vi.useFakeTimers();
    const phases: string[] = [];
    const controller = createDelayedPresenceController({ onPhaseChange: (phase) => phases.push(phase) });

    controller.setActive(true);
    vi.advanceTimersByTime(DEFAULT_PAGE_LOADER_DELAY_MS + 16);
    controller.setActive(false);
    expect(phases).toEqual(["entering", "visible", "exiting"]);
    vi.advanceTimersByTime(DEFAULT_PAGE_LOADER_EXIT_MS);
    expect(phases).toEqual(["entering", "visible", "exiting", "hidden"]);
    controller.dispose();
  });

  it("shows and hides immediately when reduced motion is enabled", () => {
    const phases: string[] = [];
    const controller = createDelayedPresenceController({ reducedMotion: true, onPhaseChange: (phase) => phases.push(phase) });

    controller.setActive(true);
    expect(phases).toEqual(["visible"]);
    controller.setActive(false);
    expect(phases).toEqual(["visible", "hidden"]);
    controller.dispose();
  });
});
