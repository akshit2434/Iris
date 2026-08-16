type RevealSchedulerOptions = {
  delayMs?: number;
  immediate?: boolean;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  onReveal: (text: string) => void;
  onComplete?: () => void;
};

export type TextRevealScheduler = {
  push: (canonicalText: string) => void;
  end: () => void;
  setImmediate: (immediate: boolean) => void;
  cancel: () => void;
};

const DEFAULT_DELAY_MS = 34;

function scheduleReveal(callback: () => void, delayMs: number) {
  return setTimeout(callback, delayMs);
}

function cancelReveal(handle: unknown) {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
}

function clampDelay(value: number) {
  return Math.max(25, Math.min(value, 45));
}

function nextChunkEnd(text: string, start: number) {
  const remaining = text.slice(start);
  const backlog = Array.from(remaining).length;
  const maxWords = backlog > 320 ? 4 : backlog > 120 ? 3 : 2;
  const maxUnits = backlog > 320 ? 36 : backlog > 120 ? 28 : 22;
  let end = 0;
  let wordCount = 0;

  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    for (const part of segmenter.segment(remaining)) {
      end += part.segment.length;
      if (part.isWordLike) wordCount += 1;
      const chunk = remaining.slice(0, end);
      const punctuation = /[.!?,;:)}\]]\s*$/.test(chunk);
      const newline = chunk.includes("\n");
      if (end >= maxUnits || newline || punctuation || (wordCount >= maxWords && /\s$/.test(part.segment))) break;
    }
  } else {
    const codePoints = Array.from(remaining);
    for (const codePoint of codePoints) {
      end += codePoint.length;
      const chunk = remaining.slice(0, end);
      if (end >= maxUnits || /[.!?,;:)}\]]\s*$/.test(chunk) || chunk.includes("\n")) break;
    }
  }

  if (end === 0) {
    const firstCodePoint = Array.from(remaining)[0];
    end = firstCodePoint?.length ?? 0;
  }
  return start + end;
}

function cadence(backlog: number, baseDelay: number) {
  if (backlog > 320) return 25;
  if (backlog > 120) return 28;
  return baseDelay;
}

/**
 * Reveals a lossless canonical string in small Unicode/word-aware chunks.
 * `end()` marks provider completion but intentionally drains the same queue,
 * so a terminal event can never pop the unread suffix into view.
 */
export function createTextRevealScheduler(options: RevealSchedulerOptions): TextRevealScheduler {
  const schedule = options.schedule ?? scheduleReveal;
  const cancel = options.cancel ?? cancelReveal;
  const baseDelay = clampDelay(options.delayMs ?? DEFAULT_DELAY_MS);
  let canonical = "";
  let visible = "";
  let immediate = options.immediate ?? false;
  let ended = false;
  let completed = false;
  let timer: unknown = null;
  let generation = 0;
  let cancelled = false;

  function clearTimer() {
    generation += 1;
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function emit(text: string) {
    if (text === visible) return;
    visible = text;
    options.onReveal(text);
  }

  function maybeComplete() {
    if (!ended || visible !== canonical || completed || cancelled) return;
    completed = true;
    options.onComplete?.();
  }

  function scheduleNext() {
    if (cancelled || immediate || timer !== null || visible === canonical) {
      maybeComplete();
      return;
    }
    const token = ++generation;
    timer = schedule(() => {
      if (cancelled || token !== generation) return;
      timer = null;
      const end = nextChunkEnd(canonical, visible.length);
      emit(canonical.slice(0, end));
      if (visible !== canonical) scheduleNext();
      else maybeComplete();
    }, cadence(Array.from(canonical.slice(visible.length)).length, baseDelay));
  }

  function revealImmediately() {
    clearTimer();
    emit(canonical);
    maybeComplete();
  }

  return {
    push(nextText) {
      if (cancelled) return;
      const isAppend = nextText.startsWith(canonical);
      if (!isAppend && nextText !== canonical) {
        clearTimer();
        canonical = nextText;
        const hadVisibleText = visible !== "";
        visible = "";
        if (hadVisibleText) options.onReveal("");
        ended = false;
        completed = false;
      } else {
        canonical = nextText;
      }
      if (immediate) revealImmediately();
      else scheduleNext();
    },
    end() {
      if (cancelled) return;
      ended = true;
      if (immediate) revealImmediately();
      else scheduleNext();
    },
    setImmediate(nextImmediate) {
      if (cancelled || immediate === nextImmediate) return;
      immediate = nextImmediate;
      if (immediate) revealImmediately();
      else scheduleNext();
    },
    cancel() {
      if (cancelled) return;
      clearTimer();
      cancelled = true;
    },
  };
}
