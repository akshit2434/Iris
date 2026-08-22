# Accountability Sweep + Delivery (Milestone 4, Phase D) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Checkbox steps.

**Goal:** Deliver due check-ins as merged conversational messages — opportunistic (post-turn lazy) plus an authenticated heartbeat endpoint — with Tier 0 template / Tier 1 small-model composition, escalation counters, and a deterministic multi-week simulation harness.

**Architecture:** `sweeper.ts` orchestrates: select deliverable due checks per profile (parent loop must be `open`; closed/paused parents get their checks cancelled), batch ≤4 into a `checkin_deliveries` row, compose the message (Tier 0 deterministic; Tier 1 small model via a title-style factory with graceful fallback), persist the assistant message into the profile's newest active thread, mark checks delivered, bump attempt/escalation counters, append `nudged` events. Triggered by `after()` in the chat route and by POST `/api/internal/accountability/sweep` guarded by the existing worker-secret pattern. A scenario simulation test drives fake weeks deterministically.

**Tech Stack:** Existing seams — repository fakes, ChatOpenRouter small-model factory (title.ts precedent), `createMessage`, worker-secret header auth, Next 16 `after()`. No new dependencies.

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md` features 4, 5, 10, delivery model. Prior: schema/repo (#4), tools (#5), context injection (#6).

## Global Constraints

- Repo-wide chain green before each commit; no DB/network in unit tests (simulation harness is fully deterministic with fakes); conventional commits; no comments unless essential.
- Delivery is person-scoped: thread choice is newest non-archived thread of the profile; if none exists, skip delivery (check stays pending, counted skipped).
- Never block or fail the user-facing request because of sweep work: lazy hook is fire-and-forget with catch-all.
- Escalation is guidance-only: increment `attempt_count`/`escalation_tier` (tier = min(attemptCount - 1, 5)); no hard caps.
- Idempotency: only `pending` checks are processed; delivery row created first (`pending`), then message, then checks marked delivered — a crash mid-way leaves pending state that the next sweep retries.
- Tier rules: single open commitment, not overdue>2d → Tier 0 template. Multi-item merge, any routine reflection, or overdue>2d catch-up → Tier 1 composer; on composer error/timeout fall back to Tier 0 text.

---

### Task 1: Sweeper core

**Files:**
- Create: `src/server/accountability/composer.ts` (Tier 0 templates + Tier 1 factory `createProductionCheckinComposer` mirroring `src/server/agent/title.ts:26-56`: OPENROUTER_TITLE_MODEL fallback, timeout 6s, reasoning effort none)
- Modify: `src/server/accountability/repository.ts` (+ `listDeliverableDueChecks(profileId, nowIso, limit)` returning `{check, loop}` joined in-memory from two queries filtering loop.status==='open'; `markCheckDelivered(profileId, checkId, {deliveryId, deliveredAt, attemptCount, escalationTier})`; reuse cancelPendingChecksForLoop for stale-parent cleanup)
- Create: `src/server/accountability/sweeper.ts`
- Test: `src/server/accountability/sweeper.test.ts`, extend `repository.test.ts`

**Interfaces:**
- Produces:
  - `runAccountabilitySweep(input?: { now?: string; profiles?: ProfileId[]; limitPerProfile?: number; repository?; composer?; messageWriter?; threadLister? }): Promise<SweepReport>` where SweepReport = `{ profiles: Array<{ profileId, selected, delivered, mergedBatches, cancelledStale, skippedNoThread }>, at: string }`.
  - `composeCheckinMessage({ loops, kind })` from composer: returns `{ text, tier }`.
- Behavior pinned by tests: batching order (due_at asc, cap 4); Tier selection rules; overdue math vs injected now; assistant message persisted with `is_complete: true` and no agentRunId; delivery row transitions pending→delivered with message_id/thread_id; attempt/tier bumped exactly once per delivery; `nudged` event appended per loop with provenance nulls; stale-parent checks cancelled with reason; no-thread skip leaves everything pending.

- [ ] **Step 1: Failing tests first** — write them as *scenarios* (see Task 3 style): "two commitments due same morning merge into one delivery", "routine weekly reflection uses composer", "closed-loop check gets cancelled", etc.
- [ ] **Step 2: RED verify** → **Step 3: implement** → **Step 4: GREEN + full suite** → **Step 5: Commit** `feat: add accountability sweep core`

### Task 2: Endpoint + lazy trigger

**Files:**
- Create: `app/api/internal/accountability/sweep/route.ts` (mirror consolidate route: nodejs runtime, `x-iris-worker-secret` via memory's hasWorkerSecret, optional `{limit}` body clamp 1..8, JSON report, no-store)
- Modify: `app/api/threads/[threadId]/messages/route.ts` — after the response is returned, `after(() => runAccountabilitySweep().catch(...))` fire-and-forget, gated by `process.env.ACCOUNTABILITY_SWEEP_DISABLED !== "true"`; import lazily to keep route lean
- Modify: `README.md` env section (+ `ACCOUNTABILITY_SWEEP_DISABLED` note); `.env.example` if present
- Test: extend sweeper.test.ts for report-shape contract; endpoint verified by typecheck/build (no harness) — state honestly

- [ ] **Steps:** tests/impl/green per house TDD where testable; **Commit** `feat: expose accountability sweep endpoint and post-turn trigger`

### Task 3: Deterministic simulation harness (fake weeks)

**Files:**
- Create: `src/server/accountability/simulation.test.ts`

**Requirements (user-mandated scenario coverage, all deterministic fakes, zero network):**
Simulate 14 consecutive days advancing `now` day-by-day against seeded fake repositories:
1. Commitment made Mon ("submit OS assignment Friday") → check scheduled Fri → delivered Fri morning as single Tier 0 message.
2. Three loops due same morning → one merged delivery ≤4 items, one assistant message, three `nudged` events, attempt_count=1 each.
3. User replies "done" mid-week (simulated via direct closeLoop tool path) → Fri check cancelled, zero deliveries for it.
4. Routine (DSA daily) → periodic reflections via composer tier flag; paused routine produces zero nudges during pause window; resume restarts.
5. Ignored check (no interaction) → next sweep re-nudge with attempt_count=2, escalation_tier=1; overdue>2d flips to catch-up phrasing tier.
6. No-thread profile → skippedNoThread, checks remain pending, later delivery once thread appears.
7. Invariant scan across all days: no delivered check ever re-delivered; every loop with terminal status has zero pending checks (no silent drops).

- [ ] **Step 1: Failing scenarios** → **Step 2: RED** → **Step 3: fix sweeper/repository gaps surfaced** → **Step 4: GREEN + full chain** → **Step 5: Commit** `test: add accountability multi-week simulation harness`

### Task 4: Live acceptance script + verification

**Files:**
- Create: `scripts/live-accountability-acceptance.mjs` (mirror scripts/live-memory-acceptance.mjs: local Supabase service role, create loop via API/tool path, force due_at past, run sweep endpoint with worker secret, assert delivery message row + cancellation flow; skip gracefully when env absent)
- [ ] **Steps:** script committed even if local supabase isn't running; attempt live execution and record result honestly; full required-checks chain; **Commit** `test: add live accountability acceptance script`

## Self-review

- Spec coverage: features 4,5,10 + delivery model complete; escalation guidance lands here, suppression wiring Phase E.
- Type consistency: SweepReport consumed by endpoint + future Home card API (Phase F reads deliveries/checks via new read methods there).
