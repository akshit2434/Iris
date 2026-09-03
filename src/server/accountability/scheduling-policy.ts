import type { Cadence, OpenLoopKind } from "./types";

const DAY_MS = 86_400_000;
const MAX_AUTOMATIC_ATTEMPTS = 4;

export type NextCheckDecision = { dueAt: string } | { dueAt: null; reason: "max_attempts" | "no_cadence" };

function validInstant(value: string): number {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error("A valid scheduling time is required.");
  return ms;
}

/** A small deterministic policy: routines follow cadence, unanswered one-offs back off. */
export function nextCheckDecision(input: {
  kind: OpenLoopKind;
  cadence: Cadence | null;
  priorAttempts: number;
  nowIso: string;
  referenceIso?: string | null;
}): NextCheckDecision {
  const now = validInstant(input.nowIso);
  if (input.kind === "routine") {
    if (!input.cadence) return { dueAt: null, reason: "no_cadence" };
    const intervalDays = input.cadence.kind === "weekly" ? 7 : input.cadence.kind === "interval_days" ? input.cadence.intervalDays ?? 1 : 1;
    let due = (input.referenceIso ? validInstant(input.referenceIso) : now) + intervalDays * DAY_MS;
    while (due <= now) due += intervalDays * DAY_MS;
    return { dueAt: new Date(due).toISOString() };
  }
  if (input.priorAttempts >= MAX_AUTOMATIC_ATTEMPTS) return { dueAt: null, reason: "max_attempts" };
  const delayDays = Math.min(7, 1 << Math.max(0, input.priorAttempts));
  return { dueAt: new Date(now + delayDays * DAY_MS).toISOString() };
}

/** "Not today" is deliberately based on response time, never an old due timestamp. */
export function nextLocalDaylightCheck(nowIso: string, deliveryContextIso?: string | null): string {
  const now = new Date(validInstant(nowIso));
  const next = new Date(now.getTime() + DAY_MS);
  const context = deliveryContextIso ? new Date(validInstant(deliveryContextIso)) : now;
  // Keep the chosen daytime clock when it is known, but always advance from now.
  const hour = context.getUTCHours();
  next.setUTCHours(hour >= 7 && hour <= 20 ? hour : 9, context.getUTCMinutes(), context.getUTCSeconds(), 0);
  return next.toISOString();
}
