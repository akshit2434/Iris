import { describe, expect, it } from "vitest";
import { canStartChatCreation, createChatExitCoordinator, type ChatSurface } from "@/lib/chat-transition";

const emptySurface: ChatSurface = { threadId: "thread-empty", ready: true, isEmpty: true, isSending: false };
const populatedSurface: ChatSurface = { threadId: "thread-populated", ready: true, isEmpty: false, isSending: false };

describe("chat creation transition", () => {
  it("does nothing for a resolved empty chat but allows populated chats", () => {
    expect(canStartChatCreation({ hasProfile: true, isCreating: false, isExiting: false, surface: emptySurface })).toBe(false);
    expect(canStartChatCreation({ hasProfile: true, isCreating: false, isExiting: false, surface: populatedSurface })).toBe(true);
    expect(canStartChatCreation({ hasProfile: true, isCreating: false, isExiting: false, surface: { ...emptySurface, isSending: true } })).toBe(true);
    expect(canStartChatCreation({ hasProfile: false, isCreating: false, isExiting: false, surface: null })).toBe(false);
  });

  it("guards duplicate starts and navigates after the short exit delay", () => {
    const scheduled: Array<() => void> = [];
    const navigations: string[] = [];
    const coordinator = createChatExitCoordinator({
      delayMs: 150,
      schedule: (callback) => { scheduled.push(callback); return callback; },
      cancel: () => undefined,
    });
    expect(coordinator.begin(() => navigations.push("new-chat"))).toBe(true);
    expect(coordinator.begin(() => navigations.push("duplicate"))).toBe(false);
    expect(coordinator.isActive()).toBe(true);
    expect(navigations).toEqual([]);
    scheduled[0]();
    expect(navigations).toEqual(["new-chat"]);
    expect(coordinator.isActive()).toBe(false);
  });

  it("cancels an exit without navigating and supports reduced motion", () => {
    const scheduled: Array<() => void> = [];
    const coordinator = createChatExitCoordinator({ schedule: (callback) => { scheduled.push(callback); return callback; }, cancel: () => undefined });
    const navigations: string[] = [];
    coordinator.begin(() => navigations.push("cancelled"));
    coordinator.cancel();
    scheduled[0]();
    expect(navigations).toEqual([]);

    const immediate = createChatExitCoordinator({ reducedMotion: true });
    expect(immediate.begin(() => navigations.push("immediate"))).toBe(true);
    expect(navigations).toEqual(["immediate"]);
  });
});
