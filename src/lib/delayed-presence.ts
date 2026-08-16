export const DEFAULT_PAGE_LOADER_DELAY_MS = 650;
export const DEFAULT_PAGE_LOADER_EXIT_MS = 180;
export const PAGE_LOADER_ENTRY_MS = 16;

export type DelayedPresencePhase = "hidden" | "entering" | "visible" | "exiting";

type DelayedPresenceOptions = {
  delayMs?: number;
  exitMs?: number;
  reducedMotion?: boolean;
  onPhaseChange: (phase: DelayedPresencePhase) => void;
};

export type DelayedPresenceController = {
  setActive: (active: boolean) => void;
  setReducedMotion: (reducedMotion: boolean) => void;
  dispose: () => void;
};

/** A small timer controller kept separate so loading behavior is easy to test without DOM rendering. */
export function createDelayedPresenceController(options: DelayedPresenceOptions): DelayedPresenceController {
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_PAGE_LOADER_DELAY_MS);
  const exitMs = Math.max(0, options.exitMs ?? DEFAULT_PAGE_LOADER_EXIT_MS);
  let phase: DelayedPresencePhase = "hidden";
  let active = false;
  let reducedMotion = options.reducedMotion ?? false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const setPhase = (next: DelayedPresencePhase) => {
    if (disposed || phase === next) return;
    phase = next;
    options.onPhaseChange(next);
  };

  const show = () => {
    clearTimer();
    if (reducedMotion) {
      setPhase("visible");
      return;
    }
    setPhase("hidden");
    timer = setTimeout(() => {
      timer = null;
      setPhase("entering");
      timer = setTimeout(() => {
        timer = null;
        setPhase("visible");
      }, PAGE_LOADER_ENTRY_MS);
    }, delayMs);
  };

  const hide = () => {
    clearTimer();
    if (phase === "hidden") return;
    if (reducedMotion) {
      setPhase("hidden");
      return;
    }
    setPhase("exiting");
    timer = setTimeout(() => {
      timer = null;
      setPhase("hidden");
    }, exitMs);
  };

  return {
    setActive(nextActive) {
      if (disposed || active === nextActive) return;
      active = nextActive;
      if (active) show();
      else hide();
    },
    setReducedMotion(nextReducedMotion) {
      if (disposed || reducedMotion === nextReducedMotion) return;
      reducedMotion = nextReducedMotion;
      if (active) show();
      else hide();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
