# Accountability boundary

This module owns the accountability domain: open loops that track commitments made in conversation, scheduled checks that evaluate them, deliveries that surface results back into chat, and suppressions that keep notifications quiet when users opt out. The UX is chat-first — loops are created, updated, and resolved through conversation rather than a dedicated UI — and scoping is person-based rather than thread-based, so a loop follows a person across conversations. See `docs/MILESTONE_4_ACCOUNTABILITY.md` for the milestone spec.

## Sweep counters and units

Sweep reports mix two counting units deliberately. `selected`, `delivered`, `cancelledStale`, `cancelledOrphans`, and `skippedNoThread` count individual scheduled checks (items), while `mergedBatches` and `failed` count delivery batches — one batch carries up to `SWEEP_MAX_BATCH` items, so a failed batch raises `failed` by exactly 1 no matter how many items it held. `suppressed` counts checks skipped because their loop title matches an active topic suppression; their claims are released immediately so they stay claimable once the suppression lifts.

## Topic suppressions

A suppression is a profile-wide "stop asking about this subject" instruction stored in `loop_suppressions`. Subjects are normalized (trimmed, whitespace-collapsed, lowercased) before storage, so matching compares loop titles to the normalized subject; only one active row per (profile, subject) exists — re-suppressing updates its reason instead of duplicating. The `loop_suppress` tool gates suppression behind clarification (one-time exception vs routine change vs never mention this topic again) and appends a `suppressed` ledger event to every open or paused loop whose title matches. Suppressed loops are excluded from the `<open-loops>` context block and skipped by sweeps; lifting via `lift: true` resumes reminders immediately.

## Soft-close reconciliation

Before composing any nudge for an open commitment overdue beyond two days, the sweep consults chat history: a bounded hybrid search for the loop title (up to three user messages since the loop was created) feeds a small-model classifier that decides whether the user already stated completion and how confident it is. A confident positive converts that loop's delivery into a deterministic confirm-close message quoting at most eighty characters of the evidence — the loop itself stays open until the user confirms, never auto-closed. Negative or uncertain classifications, empty history, and every retrieval/classifier failure fall back to the normal nudge path; reconciliation spends at most one model call per eligible loop per sweep and none when nothing qualifies.

## Claim lifecycle

Before composing anything, each sweep atomically claims due checks: `claimDueChecks` flips eligible rows to claimed through a single conditional update guarded on profile, pending status, due date, and a stale-claim window, so concurrent sweeps can never select the same rows. Successful deliveries clear the claim when they mark the check delivered; a deterministic skip (no thread yet) releases it immediately. If a sweep crashes mid-batch, claimed rows simply wait — they become claimable again once the ten-minute stale window passes, and the retry re-composes from scratch, which makes delivery at-least-once. Pending deliveries that never received a message are cancelled with a `sweep_retry` marker once they age past thirty minutes.

## Missed-commitment scanner

After each persisted chat turn whose run produced no `loop_create`, a bounded
background scan (small model, strict JSON, at most two titles per turn) checks
whether the user stated obligations that never became loops. Recovered
obligations are inserted as open commitments with provenance and a scheduled
check, so they re-enter the normal pipeline instead of vanishing. The scanner
never runs for temporary chats, dedupes against open-loop titles, and is
disabled via `ACCOUNTABILITY_SCANNER_DISABLED`.

## Recently-closed context grounding

The `<open-loops>` prompt block includes a Recently closed section (closures
from the last 48 hours, capped at three) plus a grounding rule: current-state
summaries must treat that block or a fresh `loop_list` as the only source of
truth, so closed work is never resurrected as pending from chat history.
Successful turns also emit a `loop_ledger` stream event (created/closed titles)
that the UI renders as an authoritative tracking chip.
