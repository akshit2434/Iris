# Accountability Surfaces (Milestone 4, Phase F) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Checkbox steps.

**Goal:** Make accountability visible and one-tap: a Home attention card ("what matters now"), deterministic quick-action responses on check-ins (zero-token Done/Not-today/Drop-it), an accountability API surface, and morning-briefing v0 riding the existing sweeper.

**Architecture:** New GET `/api/accountability/attention` returns the profile-scoped attention payload (unanswered deliveries with deep links, open-loop counts, overdue items); new POST `/api/accountability/respond` applies deterministic outcomes (close/drop/reschedule-check) through the repository + state machine without any model call. Home renders the card per docs/UI_STANDARDS.md using existing animation primitives; reply buttons deep-link into a new chat with prefilled context. Briefing v0 = sweeper auto-seeds one daily 08:00-local check-in per profile when absent, composed by the existing merge/tier path.

**Tech Stack:** Next.js App Router route handlers (profile cookie auth like existing routes), React client components + GSAP primitives already in src/components, repository seams, vitest fakes; Playwright CLI for the UI smoke.

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md` features 9, 5 (quick actions), delivery model. Phases A–E on main (#4–#8).

## Global Constraints

- Repo-wide chain green each commit; conventional commits; no comments unless essential.
- Profile scoping via existing server-only profile cookie resolution (`src/server/auth/profile.ts`) — never trust client-sent profileId.
- Respond endpoint is idempotent per delivery item (`responded` guard); unknown/mismatched loop↔delivery pairs rejected.
- UI follows docs/UI_STANDARDS.md (mobile-first, restrained copy, no dashboard clutter); the card shows at most 3 pending questions + count overflow line.
- No streak/guilt language anywhere in copy.

---

### Task 1: Attention + respond APIs

**Files:**
- Create: `app/api/accountability/attention/route.ts`
- Create: `app/api/accountability/respond/route.ts`
- Modify: `src/server/accountability/repository.ts` (+ `getAttentionSnapshot(profileId)`: unanswered deliveries joined with items+loop titles+thread ids; counts; top overdue commitments; + `respondToDeliveryItem(profileId, {deliveryId, loopId, outcome})` transitioning loop via state machine, marking item responded, setting delivery answered_at when all items answered)
- Test: `src/server/accountability/repository.test.ts` extensions; route-level behavior covered via these units + typecheck (state honestly)

- [ ] Steps: failing repo tests → implement → routes wired with 401-on-no-profile + zod input validation → full chain → commit `feat: add accountability attention and response APIs`

### Task 2: Home attention card + chat quick actions

**Files:**
- Create: `src/components/home-attention-card.tsx` (+ test if pattern exists for component tests — otherwise logic in `src/lib/home-attention.ts` with unit tests)
- Modify: `src/app/(protected)/page.tsx` or its home-screen component (mount card above chat entry)
- Create: `src/lib/checkin-actions.ts` (pure helpers: build deep-link/prefill payloads for Done/Not-today/Drop-it → new-chat composer text; unit tests)
- Modify: chat assistant message rendering for `checkin` deliveries: render three inline quick-action buttons when message metadata marks it as a check-in (reuse existing tool-event/message metadata plumbing; keep fallback plain text)
- Test: `src/lib/checkin-actions.test.ts`, extend existing home/composer lib tests

- [ ] Steps: pure-lib TDD first → components mount → `npm run build` → Playwright smoke vs local dev server (screenshot desktop+mobile widths, verify card renders with seeded data and buttons navigate) → commit `feat: add accountability home card and quick actions`

### Task 3: Morning briefing v0 + final verification

**Files:**
- Modify: `src/server/accountability/sweeper.ts` (before claim: ensure each profile has a pending briefing check for today at 08:00 profile-local when any open loop exists; reuse cadence-less scheduled_check; mark kind via cancel_reason-free convention — store `"briefing"` in checkin_deliveries.summary prefix or a loop-less pseudo-item; simplest honest v0: seed a real scheduled_check tied to a synthetic "Morning briefing" routine-like loop created lazily per profile)
- Modify: simulation.test.ts (scenario 12: briefing appears at 08:00 local, lists carried-over loops, never duplicates same-day)
- Full chain + live acceptance rerun (supabase running locally)
- Commit `feat: seed daily morning briefing checks`

## Self-review

- Spec coverage: feature 9 complete except Web Push (explicitly deferred); quick actions deliver feature 5's zero-cost answers.
- Known deferred: backlog-on-lift burst product question rides; briefing tone stays merged-summary v0.
