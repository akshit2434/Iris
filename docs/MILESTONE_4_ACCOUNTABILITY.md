# Milestone 4 — Accountability

Design of record for Milestone 4. Implementation order follows `iris_context_pack/BUILD_PLAN.md`; this document is the public engineering spec. Private seed context stays out of Git.

## Goal

> Mention a responsibility naturally. Iris clarifies if needed, schedules appropriate follow-up, cancels that follow-up if completion is mentioned elsewhere, and does not silently forget the open loop.

## Design principles

From the product vision and runtime guidance:

- **Event-driven, never polled LLMs.** Reminders are database rows with explicit `due_at`. A reminder event re-enters the agent at delivery time with current state. No continuous model polling.
- **Loops belong to the person, not to a chat.** `profile_id` is the only scoping dimension. Origin thread/message IDs are stored purely as deep-link provenance ("where did we decide this?"), never as routing.
- **Chat is the interface.** Check-ins arrive as conversational messages, merged when several are due at once ("Quick check: paperwork, today's DSA and medicine are still unresolved").
- **Nothing disappears silently.** A meaningful loop stays visible until completed, explicitly cancelled, rescheduled, replaced, or agreed to no longer matter.
- **Dynamic over hardcoded.** Escalation salience is soft guidance passed to the agent (attempt counts, days open, last response), never a mechanical nudge cap. The agent chooses tone from context; the user can always suppress.
- **Systems over streaks.** Routine check-ins report recent progress patterns, never streak counters.
- **Raw history is preserved.** Accountability tables reference messages; they never replace or rewrite them.

## Feature set

1. **Open loops** — commitments tracked through a state machine (`open → paused → done/cancelled/dropped`).
2. **Kinds** — `commitment` (one-off, has `due_at`), `routine` (has cadence, periodic reflective checks), `idea` (parked musings; visible, never nagged).
3. **Commitment clarification** — the agent asks why / capacity / realistic timing / conflicts before creating a loop. Musings stay ideas unless confirmed.
4. **Scheduled checks** — future check rows with `due_at`; delivery composes the message at delivery time, never in advance.
5. **Merged check-ins** — due checks batched into one delivery row and one message (cap ~4 items); items answered elsewhere earlier are dropped from the batch.
6. **Cross-chat completion** — completion stated casually in any chat closes the matching loop live during that turn (agent sees open-loop summaries in context); retrieval-based reconciliation before nagging acts as backstop (soft-close with confirm, never hard auto-cancel).
7. **Escalation as guidance** — ignored checks increase attempt/tier counters that inform agent tone; no hard limit, silence floor respected, user override always wins.
8. **Suppression without settings pages** — "stop asking about X" in chat → clarified (exception vs routine change) → durable suppression row, liftable conversationally.
9. **Surfaces** — Home attention card (pending check-in questions + overdue count, agent-generated options, one-tap answers drop into the composer), compact check-in UI, morning briefing v0.
10. **Delivery tiers** — Tier 0 deterministic templates and quick-action taps cost zero tokens; Tier 1 small-model phrasing for merges/reflections/catch-ups; full agent re-entry reserved for real conversations.

## Delivery model

- **Primary: app-wake sweep.** The active profile runs a cheap indexed sweep when Home opens and when the app returns to foreground. It delivers exactly when a human can see it; idle system costs nothing.
- **Secondary: deployment heartbeat.** A version-controlled Vercel cron invokes the protected worker adapter every five minutes. Lateness is bounded while the app is closed; empty runs are indexed work only.
- **Precision escape hatch.** The sweep endpoint is idempotent ("process everything due"), so any trigger — including vendor one-shot schedulers — can be swapped in later without touching application logic.

## Data model (Phase A)

All tables profile-scoped with RLS enabled, revoked from `public/anon/authenticated`, composite foreign keys `(id, profile_id)` matching the memory migrations' conventions. Append-only ledgers are protected by immutability triggers.

| Table | Purpose |
| --- | --- |
| `open_loops` | Current loop state: title, kind, status, `due_at`, cadence JSONB, provenance |
| `loop_events` | Append-only audit ledger: created/rescheduled/nudged/completed/reopened/suppressed… |
| `scheduled_checks` | Future checks: `due_at`, status, attempt/escalation counters, delivery link |
| `checkin_deliveries` | Merged delivery batches: thread, composed summary, answered-at |
| `checkin_delivery_items` | Delivery ↔ loop membership |
| `loop_suppressions` | Durable topic-level "stop asking" instructions, liftable |

## Build phases

Each phase leaves Iris usable and fully checked (`npm run check:secrets && npm run check:privacy && npm run lint && npm run typecheck && npm run build && npm test`).

| Phase | Scope | Branch |
| --- | --- | --- |
| A ✅ | Schema, migrations, contract tests, domain types, state machine, repository (#4) | `feature/accountability-schema` |
| B ✅ | Agent tools (`loop_create/update/close/list`, `schedule_check`) with clarification gate (#5) | `feature/accountability-tools` |
| C ✅ | Open-loop context injection + clarify/close prompt guidance (#6); detection backstop moved to Phase E reconciliation | `feature/accountability-detection` |
| D ✅ | Sweep endpoint (worker-auth guarded), post-turn lazy sweep, Tier 0/1 delivery, merge logic, 14-day simulation harness, live acceptance PASS (#7) | `feature/accountability-sweep` |
| E ✅ | Atomic claim RPC, soft-close reconciliation, suppressions, tier-aware escalation, FK fix — live acceptance PASS (#8) | `feature/accountability-followup` |
| F ✅ | Attention/respond APIs, delivery-items seeding, Home card + one-tap quick actions, chat inline actions, briefing v0 — browser-verified via Playwright (#9) | `feature/accountability-surfaces` |
| R ✅ | App-wake delivery, deterministic recurrence/backoff, local first-class briefings, live delivery refresh, permissioned Web Push, and cron worker adapter | `feature/personal-agent-reliability` |

## Explicit non-goals for this milestone

- Habit-tracker features: streak walls, completion percentages, guilt mechanics
- Location/time-aware nudges (requires telemetry milestones)
- Cross-profile anything

## Acceptance harness

A live script (`scripts/live-accountability-acceptance.mjs`) mirrors the memory acceptance flow: mention a responsibility in Chat A → verify clarification → verify scheduled check row → mention completion casually in Chat B → verify closure and pending-check cancellation → verify no silent drops remain.

## Milestone status

**Complete.** All six phases landed through #4–#9 with live acceptance passing against local Supabase and a Playwright-verified UI flow.

Known deferred items (documented, non-blocking):
- Briefing v1 is deterministic from open loops and overdue state; calendar, weather, capacity, and telemetry context remain later integrations.
- Web Push is available only after the person grants browser permission and VAPID keys are configured; it is not a native alarm channel.
- Backlog-on-lift burst after lifting a suppression delivers up to the batch cap at once.
