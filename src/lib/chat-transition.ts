export type ChatSurface = {
  threadId: string;
  ready: boolean;
  isEmpty: boolean;
  isSending: boolean;
};

export type ChatCreationGuardInput = {
  hasProfile: boolean;
  isCreating: boolean;
  isExiting: boolean;
  surface: ChatSurface | null;
};

/** The shell may create from a populated chat, but an already-empty chat is a no-op. */
export function canStartChatCreation({ hasProfile, isCreating, isExiting, surface }: ChatCreationGuardInput) {
  if (!hasProfile || isCreating || isExiting) return false;
  if (surface?.ready && surface.isEmpty && !surface.isSending) return false;
  return true;
}

type ChatExitCoordinatorOptions = {
  delayMs?: number;
  reducedMotion?: boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
};

export type ChatExitCoordinator = {
  begin: (navigate: () => void) => boolean;
  cancel: () => void;
  isActive: () => boolean;
};

function defaultSchedule(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}

function defaultCancel(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

/**
 * Coordinates the short visual exit with route handoff. It is intentionally
 * dependency-injected so duplicate clicks, cancellation, and reduced-motion
 * behavior stay deterministic without a browser or network request.
 */
export function createChatExitCoordinator(options: ChatExitCoordinatorOptions = {}): ChatExitCoordinator {
  const delayMs = options.delayMs ?? 150;
  const reducedMotion = options.reducedMotion ?? false;
  const schedule = options.schedule ?? defaultSchedule;
  const cancel = options.cancel ?? defaultCancel;
  let active = false;
  let handle: unknown = null;

  function cancelPending() {
    if (handle !== null) cancel(handle);
    handle = null;
    active = false;
  }

  return {
    begin(navigate) {
      if (active) return false;
      active = true;
      if (reducedMotion) {
        active = false;
        navigate();
        return true;
      }
      handle = schedule(() => {
        handle = null;
        if (!active) return;
        active = false;
        navigate();
      }, delayMs);
      return true;
    },
    cancel: cancelPending,
    isActive: () => active,
  };
}
