import type { LoopEventKind, OpenLoopStatus } from "./types";

const TRANSITIONS: Record<OpenLoopStatus, Partial<Record<LoopEventKind, OpenLoopStatus>>> = {
  open: {
    created: "open",
    clarified: "open",
    rescheduled: "open",
    paused: "paused",
    nudged: "open",
    completed: "done",
    cancelled: "cancelled",
    dropped: "dropped",
    suppressed: "open",
    note: "open",
  },
  paused: {
    clarified: "paused",
    rescheduled: "paused",
    resumed: "open",
    reopened: "open",
    nudged: "paused",
    completed: "done",
    cancelled: "cancelled",
    dropped: "dropped",
    suppressed: "paused",
    note: "paused",
  },
  done: {
    reopened: "open",
  },
  cancelled: {
    reopened: "open",
  },
  dropped: {
    reopened: "open",
  },
};

export function nextStatusOnEvent(current: OpenLoopStatus, event: LoopEventKind): OpenLoopStatus | null {
  return TRANSITIONS[current][event] ?? null;
}

export function isTerminal(status: OpenLoopStatus): boolean {
  return status === "done" || status === "cancelled" || status === "dropped";
}
