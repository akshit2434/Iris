# Accountability Follow-up Intelligence (Milestone 4, Phase E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Checkbox steps.

**Goal:** Make follow-up safe under concurrency and intelligent under silence — atomic check claiming, soft-close reconciliation before nagging, durable topic suppressions, tier-aware escalation tone, and sweep observability.

**Architecture:** Claim-before-compose fixes duplicate deliveries (conditional pending-guarded update acts as the reservation); a reconciler consults recent chat history via the existing retrieval service plus a small-model classifier to detect already-stated completions and converts the nudge into a one-tap soft-close confirmation; suppressions get repository CRUD, an agent tool with clarification gate, and sweeper filtering; the composer gains tone-by-tier guidance (ask what changed, never guilt).

**Tech Stack:** Existing seams only — repository fakes, ChatOpenRouter small model, memory retrieval service (`searchMessages` RPC), vitest fakes/simulation harness.

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md` features 5, 6-backstop, 7, 8. Prior phases on main through #7.

## Global Constraints

- Repo-wide chain green each commit; no DB/network unit tests; conventional commits; no comments unless essential.
- GATING: Task 1 must land before any heartbeat/cron wiring (final-review I1/I2 ruling).
- Soft-close never hard-closes: classifier-positive overdue items produce a confirmation-style check-in referencing the evidence; closure still requires user tap/statement.
- Reconciliation is cost-bounded: runs only for open commitments overdue >2d, ≤3 candidate messages, one small-model call max per loop per sweep.
- Suppression semantics: topic-level, profile-scoped, liftable; suppressed items are skipped by sweeps (counted `suppressed` in report), excluded from context loader blocks.
- Escalation is guidance-only (no hard caps): tier informs tone only — tier ≥2 asks what changed / offers reschedule or drop; never punitive phrasing, never streak language.

---

### Task 1 (GATING): Atomic claim + hygiene batch

**Files:** Modify `src/server/accountability/repository.ts` (+tests), `sweeper.ts` (+tests), `composer.ts`, minor renames.
**Requirements:**
1. `claimDueChecks(profileId, limit)` — atomically transitions selected pending checks to a claimed state via conditional UPDATE … WHERE status='pending' RETURNING rows (reuse markCheckDelivered guard style; add `claiming` handling WITHOUT schema change: claim = conditional increment of attempt_count WHERE status='pending' AND due_at<=now, then re-select those ids — simplest correct shape is single conditional update setting status='delivered'? NO — that breaks crash recovery. Correct minimal design: add `claimed_at` via ALTER TABLE migration `20260830000000_accountability_claim.sql`; claim = UPDATE SET claimed_at=now() WHERE status='pending' AND claimed_at IS NULL AND due_at<=now RETURNING; sweeper processes claimed set; on success mark delivered (existing); on crash, next sweep re-claims rows whose claimed_at < now()-10min (stale-claim reclaim predicate).)
2. Sweeper uses claim step before compose/write; double-sweep test asserts exactly one message.
3. Partial-failure: if message write fails after claim, checks stay claimed → stale-reclaim path retries later; failed batch counted; orphan pending deliveries cancelled on next sight (delivery status 'pending' older than 30min with no message_id → mark cancelled reason 'sweep_retry').
4. Rename listDeliverableDueChecks→listDueChecksWithLoops (+callers/tests).
5. Composer truncation slices at last word boundary; SweepReport documents item-vs-batch counting in its type doc comment… (house rule says no comments — put units note in README section of accountability module instead).
- Steps: failing tests (double-sweep, crash-retry, orphan-cancel) → implement → green → commit `fix: claim accountability checks atomically before delivery`

### Task 2: Topic suppressions

**Files:** Modify `repository.ts` (+ insertLoopSuppression, liftLoopSuppression, listActiveSuppressions, subject-match helper), `tools.ts` (+ `loop_suppress` with clarify-gate confirm:true, lift param), `context-loader.ts` (exclude suppressed-subject loops from block), `sweeper.ts` (filter + count `suppressed`), tests all around; runtime.test.ts name arrays +1.
- Commit `feat: add conversational loop suppressions`

### Task 3: Soft-close reconciliation

**Files:** Create `src/server/accountability/reconciler.ts`; modify `sweeper.ts` (pre-composition hook for overdue commitments), `composer.ts` (soft-close template variant); tests incl. new simulation scenario (completion mentioned casually days earlier → sweep produces confirm-close message citing evidence, not a nag; classifier-negative → normal catch-up).
**Seams:** `retrieval` (wraps memory searchMessages RPC via production factory, fake in tests), `classifier` (small-model factory mirroring title.ts; returns {completed:boolean, confidence:number} ; errors → treat as not-completed).
- Commit `feat: reconcile stated completions before accountability nudges`

### Task 4: Escalation tone + observability

**Files:** Modify `composer.ts` (tone-by-tier: tier0 neutral, tier1 gentle reminder, tier≥2 "this keeps slipping — still important? want to reschedule or drop it?" + routine pattern-reflection wording), `sweeper.ts` (structured console.warn in catch blocks with counts), tests; then FULL required-checks chain + live acceptance script rerun if local supabase available.
- Commit `feat: tier-aware escalation tone and sweep observability`

## Self-review

- Spec coverage: features 5 (merged+answered-drop), 6 backstop (soft-close), 7 (guidance-only escalation), 8 (suppression without settings pages). Phase F surfaces remain.
- Gating honored: Task 1 first; heartbeat still unwired until after it lands.
