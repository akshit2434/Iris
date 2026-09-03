const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

export const BRIEFING_HOUR_LOCAL = 8;
/** @deprecated Briefings are no longer represented by loops. */
export const BRIEFING_HOUR_UTC = BRIEFING_HOUR_LOCAL;
/** @deprecated Kept only to read historical records safely. */
export { BRIEFING_LOOP_TITLE, isBriefingLoopTitle } from "@/lib/briefing";

export type BriefingCheckRef = { status: string; dueAt: string; deliveredAt: string | null };
export type BriefingDayWindow = { startMs: number; endMs: number };

export function composeBriefingText(loops: readonly { title: string; kind: string; dueAt: string | null }[], nowIso: string): string {
  const open = loops.filter((loop) => loop.kind !== "briefing");
  const overdue = open.filter((loop) => loop.dueAt && Date.parse(loop.dueAt) < Date.parse(nowIso));
  const priority = [...open].sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999"))[0];
  const lines = ["Morning briefing."];
  if (overdue.length) lines.push(`Carried over: ${overdue.slice(0, 2).map((loop) => loop.title).join(", ")}.`);
  if (priority) lines.push(`Priority: ${priority.title}.`);
  lines.push("Keep the restart small and honest.");
  return lines.join(" ");
}

function parseInstant(nowIso: string): number {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) throw new Error("A valid briefing scheduling time is required.");
  return nowMs;
}

function localParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23", minute: "2-digit" }).formatToParts(instant);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)])) as Record<string, number>;
}

/** Returns the next 08:00 in a confirmed IANA timezone, falling back to UTC. */
export function nextBriefingDueAt(nowIso: string, timeZone = "UTC"): string {
  const nowMs = parseInstant(nowIso);
  let zone = timeZone;
  try { localParts(new Date(nowMs), zone); } catch { zone = "UTC"; }
  const local = localParts(new Date(nowMs), zone);
  const dayOffset = local.hour < BRIEFING_HOUR_LOCAL ? 0 : 1;
  const targetDate = new Date(Date.UTC(local.year, local.month - 1, local.day + dayOffset, BRIEFING_HOUR_LOCAL));
  // Offset-correct the nominal local timestamp. Re-evaluate once for DST transitions.
  const offset = targetDate.getTime() - Date.UTC(localParts(targetDate, zone).year, localParts(targetDate, zone).month - 1, localParts(targetDate, zone).day, localParts(targetDate, zone).hour, localParts(targetDate, zone).minute);
  return new Date(targetDate.getTime() + offset).toISOString();
}

export function briefingDayWindow(nowIso: string, timeZone = "UTC"): BriefingDayWindow {
  const nowMs = parseInstant(nowIso);
  const local = localParts(new Date(nowMs), timeZone);
  const nominal = Date.UTC(local.year, local.month - 1, local.day);
  const midnightParts = localParts(new Date(nominal), timeZone);
  const startMs = nominal + (nominal - Date.UTC(midnightParts.year, midnightParts.month - 1, midnightParts.day, midnightParts.hour, midnightParts.minute));
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
