# Accountability boundary

This module owns the accountability domain: open loops that track commitments made in conversation, scheduled checks that evaluate them, deliveries that surface results back into chat, and suppressions that keep notifications quiet when users opt out. The UX is chat-first — loops are created, updated, and resolved through conversation rather than a dedicated UI — and scoping is person-based rather than thread-based, so a loop follows a person across conversations. See `docs/MILESTONE_4_ACCOUNTABILITY.md` for the milestone spec.

## Sweep counters and units

Sweep reports mix two counting units deliberately. `selected`, `delivered`, `cancelledStale`, `cancelledOrphans`, and `skippedNoThread` count individual scheduled checks (items), while `mergedBatches` and `failed` count delivery batches — one batch carries up to `SWEEP_MAX_BATCH` items, so a failed batch raises `failed` by exactly 1 no matter how many items it held. `suppressed` counts checks skipped because their loop title matches an active topic suppression; their claims are released immediately so they stay claimable once the suppression lifts.

## Topic suppressions

A suppression is a profile-wide "stop asking about this subject" instruction stored in `loop_suppressions`. Subjects are normalized (trimmed, whitespace-collapsed, lowercased) before storage, so matching compares loop titles to the normalized subject; only one active row per (profile, subject) exists — re-suppressing updates its reason instead of duplicating. The `loop_suppress` tool gates suppression behind clarification (one-time exception vs routine change vs never mention this topic again) and appends a `suppressed` ledger event to every open or paused loop whose title matches. Suppressed loops are excluded from the `<open-loops>` context block and skipped by sweeps; lifting via `lift: true` resumes reminders immediately.

## Claim lifecycle

Before composing anything, each sweep atomically claims due checks: `claimDueChecks` flips eligible rows to claimed through a single conditional update guarded on profile, pending status, due date, and a stale-claim window, so concurrent sweeps can never select the same rows. Successful deliveries clear the claim when they mark the check delivered; a deterministic skip (no thread yet) releases it immediately. If a sweep crashes mid-batch, claimed rows simply wait — they become claimable again once the ten-minute stale window passes, and the retry re-composes from scratch, which makes delivery at-least-once. Pending deliveries that never received a message are cancelled with a `sweep_retry` marker once they age past thirty minutes.
