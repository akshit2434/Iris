const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

export const BRIEFING_LOOP_TITLE = "Morning briefing";
export const BRIEFING_HOUR_UTC = 8;

export type BriefingCheckRef = { status: string; dueAt: string; deliveredAt: string | null };
export type BriefingDayWindow = { startMs: number; endMs: number };

export function isBriefingLoopTitle(title: string): boolean {
  return title === BRIEFING_LOOP_TITLE;
}

function utcDayStartMs(nowMs: number): number {
  return Math.floor(nowMs / MS_PER_DAY) * MS_PER_DAY;
}

function parseInstant(nowIso: string): number {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error("A valid briefing scheduling time is required.");
  return nowMs;
}

/** Profiles carry no stored timezone yet, so "profile-local" is UTC in v0. */
export function nextBriefingDueAt(nowIso: string): string {
  const nowMs = parseInstant(nowIso);
  const todayDueMs = utcDayStartMs(nowMs) + BRIEFING_HOUR_UTC * MS_PER_HOUR;
  return new Date(nowMs < todayDueMs ? todayDueMs : todayDueMs + MS_PER_DAY).toISOString();
}

export function briefingDayWindow(nowIso: string): BriefingDayWindow {
  const nowMs = parseInstant(nowIso);
  const startMs = utcDayStartMs(nowMs);
  return { startMs, endMs: startMs + MS_PER_DAY };
}

export function hasBlockingBriefingCheck(checks: readonly BriefingCheckRef[], window: BriefingDayWindow): boolean {
  return checks.some((check) => {
    if (check.status === "pending") {
      const dueMs = Date.parse(check.dueAt);
      return Number.isFinite(dueMs) && dueMs >= window.startMs;
    }
    if (check.status !== "delivered" || check.deliveredAt === null) return false;
    const deliveredMs = Date.parse(check.deliveredAt);
    return Number.isFinite(deliveredMs) && deliveredMs >= window.startMs && deliveredMs < window.endMs;
  });
}

export function isStaleBriefingCheck(check: BriefingCheckRef, window: BriefingDayWindow): boolean {
  if (check.status !== "pending") return false;
  const dueMs = Date.parse(check.dueAt);
  return Number.isFinite(dueMs) && dueMs < window.startMs;
}
