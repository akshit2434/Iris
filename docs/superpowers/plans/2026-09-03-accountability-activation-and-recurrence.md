# Accountability activation, recurrence, and briefing correctness

**Goal:** Make “open Iris → see what matters” reliable, ensure open loops receive appropriate future attention without repeated LLM work, and replace the placeholder briefing behavior with a useful in-app morning briefing.

**Proposed branch:** `feature/accountability-reliability`

## Product decisions

- App wake runs a profile-scoped, idempotent sweep. It is database-first and never waits on an LLM.
- Single fresh checks use deterministic copy. Model composition remains optional for merged, reflective, or soft-close cases and must never block Home from becoming usable.
- The server, not the model, materializes future checks for routines and ignored commitments. The model chooses intent/timing initially and handles reflective conversation after delivery.
- “Not today” schedules relative to the response time, with a sane default of the next local day at a chosen daylight hour; it never reuses a stale overdue timestamp.
- A briefing is a distinct delivery type, not a synthetic open loop named “Morning briefing”. It is informational, auto-acknowledged, local-time aware, and never appears as an unanswered follow-up.
- All delivery selection stays profile-scoped. App wake never sweeps another selected profile.

## Phase A — app wake

1. Add a protected active-profile sweep route or extend the existing sweep service with explicit `profiles: [profileId]` support. The public route derives profile scope from the profile cookie; the worker route retains secret-authenticated multi-profile operation.
2. Call it on Home/profile readiness and on `visibilitychange` return with a client cooldown (for example, two minutes). Run it in parallel with the initial attention fetch, then refresh attention when the report says a delivery changed.
3. Return a compact report only: delivered count, affected thread IDs, and whether an optional composition is pending/failed. Do not return private loop contents unnecessarily.
4. Add integration tests proving: a due check appears after app open without a chat message; repeated wake calls do not duplicate delivery; profile A cannot cause profile B delivery.

## Phase B — recurring checks and ignored commitments

1. Extend scheduled-check metadata with a delivery purpose and recurrence policy sufficient to distinguish `initial`, `routine`, `follow_up`, and `briefing` work. Keep immutable audit events.
2. Add a pure scheduling policy module. Inputs: loop kind, cadence, due date, prior attempts, latest response, local timezone, and now. Output: at most one next pending check, a no-send result, or a prompt-for-clarification result.
3. On successful delivery, atomically materialize the next eligible check for routines and unresolved commitments. Use a silence floor/backoff and a maximum automatic horizon so the system stays helpful rather than nagging.
4. Respect pause, suppression, terminal status, and an explicit user reschedule by cancelling/replacing future checks transactionally.
5. Update loop creation so routines schedule their first cadence occurrence automatically. Preserve the ability for the agent to create a one-off extra check.
6. Replace the scanner’s fixed 12-hour default with an explicitly marked recovery flow: it creates a pending clarification, or a conservative first check only for an unambiguously dated obligation. It must not silently bypass capacity/timing clarification.
7. Add simulations for ignored commitments, routine cadence across timezone changes, pauses, suppressions, explicit completion in another chat, and bounded repeated follow-up.

## Phase C — quick actions and briefing

1. Replace `later = original_due_at + 24h` with a scheduler call based on `now`, local timezone, and optional delivery context. Make “Not today” visible as a proposed new time in the next chat response when the timing is ambiguous.
2. Introduce a first-class briefing delivery record/type. It has no open-loop row, no response action, and is marked consumed once rendered.
3. Store a confirmed profile timezone from onboarding and schedule briefings at a local default (initially 08:00 local). On first use without a timezone, do not claim local scheduling; use browser time only for that session.
4. Compose briefing v1 deterministically from open loops and recently delivered/overdue items: carried-over commitments, one nearest meaningful priority, and a concise recovery note. Do not use an LLM by default. Calendar/context sections remain reserved for later connectors.
5. Add regression tests proving historical briefings do not persist as pending Home attention items and that the reserved exact title collision disappears.

## Acceptance criteria

- A due reminder becomes visible after app open, before the user sends a message.
- Ignoring a check creates a bounded, appropriately delayed next check without model polling.
- A daily/weekly routine creates its own future check schedule and respects pause/suppression.
- “Not today” never immediately re-delivers an already-overdue item.
- A briefing arrives at the person’s confirmed local morning, reads as a briefing, and does not become an unanswerable task.

## Non-goals

- Web Push; that is planned separately.
- Calendar, location, or telemetry-driven capacity reasoning.
- Gamified streaks or rigid automated punishments.

