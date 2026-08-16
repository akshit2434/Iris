export const CHAT_SCROLL_THRESHOLD = 120;

export type ScrollMetrics = Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">;

export type ScrollFollowState = {
  nearBottom: boolean;
  manual: boolean;
  follow: boolean;
};

export type ChatScrollMotion = "auto" | "smooth";

type BottomScrollSchedulerOptions = {
  intervalMs?: number;
  reducedMotion?: () => boolean;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export type BottomScrollScheduler = {
  request: (shouldFollow: () => boolean, scroll: (motion: ChatScrollMotion) => void) => void;
  cancel: () => void;
};

export const INITIAL_SCROLL_FOLLOW_STATE: ScrollFollowState = {
  nearBottom: true,
  manual: false,
  follow: true,
};

export function measureScrollFollowState(metrics: ScrollMetrics, threshold = CHAT_SCROLL_THRESHOLD): ScrollFollowState {
  const nearBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
  return { nearBottom, manual: !nearBottom, follow: nearBottom };
}

export function returnToBottomState(): ScrollFollowState {
  return INITIAL_SCROLL_FOLLOW_STATE;
}

function defaultSchedule(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}

function defaultCancel(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Coalesces streamed layout changes into an intentional bottom-follow update.
 * The caller owns the follow predicate, so a manual upward scroll always wins
 * over a queued update. Keeping this scheduler independent makes its timing
 * and reduced-motion contract deterministic without browser automation.
 */
export function createBottomScrollScheduler(options: BottomScrollSchedulerOptions = {}): BottomScrollScheduler {
  const intervalMs = options.intervalMs ?? 120;
  const reducedMotion = options.reducedMotion ?? (() => false);
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;
  let lastScrollAt = Number.NEGATIVE_INFINITY;
  let pending = false;
  let handle: unknown = null;
  let generation = 0;

  function clearPending() {
    if (handle !== null) cancel(handle);
    handle = null;
    pending = false;
    generation += 1;
  }

  return {
    request(shouldFollow, scroll) {
      if (pending) return;
      pending = true;
      const requestGeneration = generation;
      const delayMs = Math.max(0, intervalMs - (now() - lastScrollAt));
      handle = schedule(() => {
        handle = null;
        pending = false;
        if (requestGeneration !== generation) return;
        if (!shouldFollow()) return;
        lastScrollAt = now();
        scroll(reducedMotion() ? "auto" : "smooth");
      }, delayMs);
    },
    cancel: clearPending,
  };
}
