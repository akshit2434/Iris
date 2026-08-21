# Accountability Agent Tools (Milestone 4, Phase B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Give the Iris agent governed open-loop tools — clarify-gated creation, listing, updating/rescheduling, closing with pending-check cancellation, and extra scheduled checks — wired into the internal toolset behind an option flag.

**Architecture:** New `src/server/accountability/tools.ts` mirrors `src/server/agent/tools.ts`: LangChain `tool()` wrappers around thin functions taking `(context, input, service)`, services lazily resolved with DI overrides for tests, discriminated-union outputs. The repository from Phase A is the only persistence path. Wiring appends the tools in `createInternalTools` gated by `options.accountabilityEnabled !== false`.

**Tech Stack:** LangChain `tool`, zod, vitest with fake repositories (no DB/network).

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md`. Phase A artifacts on main: `src/server/accountability/{types,state-machine,repository}.ts`, migration `20260829000000_accountability_foundation.sql`.

## Global Constraints

- Same as repo-wide: checks before every commit (`check:secrets`, `check:privacy`, `lint`, `typecheck`, `build`, plus `npm test` green); no network/DB in tests; no comments unless essential; conventional commits.
- All tools profile-scoped via `runtime.context.profileId` — never accept a profileId parameter from model input.
- Clarification gate: `loop_create` MUST NOT persist unless `confirm: true`; unconfirmed calls return guidance output only.
- Closing a loop must cancel its pending checks in the same tool call flow (Phase D sweep relies on this hygiene; final review triage requirement).
- Tool descriptions follow existing voice: imperative, when-to-use, what-not-to-do.

Carry-forwards from Phase A review (address opportunistically here): M1 reopen-path repository test; input-length pre-validation now that tools face the model directly.

---

### Task 1: Accountability tools module

**Files:**
- Create: `src/server/accountability/tools.ts`
- Test: `src/server/accountability/tools.test.ts`

**Interfaces:**
- Consumes: `createAccountabilityRepository` (or injected partial), domain schemas from `./types`, `nextStatusOnEvent` from `./state-machine`, `AgentContext` from `@/server/agent/context`.
- Produces:
  - `createAccountabilityTools(repository?: AccountabilityRepository)` returning array of LangChain tools named exactly: `loop_list`, `loop_create`, `loop_update`, `loop_close`, `schedule_check` (this order).
  - Output unions: `{ kind: "loop_list", loops: [...] }`; `{ kind: "loop_create", status: "needs_confirmation" } | { kind: "loop_create", status: "created", loopId, dueAt }`; `{ kind: "loop_update", status: "updated", loopId }`; `{ kind: "loop_close", status: "closed", loopId, cancelledChecks: number }`; `{ kind: "schedule_check", status: "scheduled", checkId, dueAt }`. Error outputs: `{ kind, status: "error", message }` — never throw across the tool boundary except programmer errors.

- [ ] **Step 1: Failing tests** (fake repository recording calls):
  - `loop_create` with `confirm:false` → no repository writes; output `needs_confirmation` whose `message` instructs the model to clarify why/capacity/timing/conflicts first.
  - `loop_create` confirmed commitment with dueAt → inserts loop, appends `created` event with provenance from context (threadId/currentUserMessageId/agentRunId), schedules initial check, returns ids.
  - `loop_create` routine without cadence → schema rejection before any write.
  - `loop_close` completed → `updateOpenLoopStatus` called with expected `updatedAt`, `completed` event appended, `cancelPendingChecksForLoop` returns count surfaced in output.
  - `loop_close` on terminal loop → illegal-transition error output, zero cancellations.
  - `schedule_check` → pending row inserted for an open loop; rejected for closed loop.
  - `loop_update` reschedule/pause/resume paths set correct event kinds.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** five tools following the wrapper style of `src/server/agent/tools.ts:352-455`.
- [ ] **Step 4: Run to verify pass**, then full `npm test`.
- [ ] **Step 5: Commit** `feat: add accountability agent tools`

### Task 2: Wire into internal toolset

**Files:**
- Modify: `src/server/agent/tools.ts` (`InternalToolOptions` gains `accountabilityEnabled?: boolean`; `createInternalTools` gains optional trailing `accountabilityRepository` param; append tools after memory tools)
- Modify: `src/server/agent/index.ts` (pass-through plumb on `createIrisAgent`/`createProductionAgent` input types, same shape as savedMemoryEnabled)
- Modify: `src/server/accountability/repository.ts` only if adding `createProductionAccountabilityRepository()` export is missing (factory using `getDatabase()`)
- Test: modify `src/server/agent/runtime.test.ts:226-258` expected-name arrays (+5 names; disabled-flag case asserts exclusion)

- [ ] **Step 1: Update runtime.test.ts expectations first (failing).**
- [ ] **Step 2: Wire plumbing minimally; keep `getInternalToolSchemaDescriptors` consistent automatically.**
- [ ] **Step 3: `npm test && npm run lint && npm run typecheck && npm run build` all green.**
- [ ] **Step 4: Commit** `feat: expose accountability tools to agent runtime`

### Task 3: Carry-forward hygiene + live smoke prep

- [ ] **Step 1:** Add repository reopen-path test (M1) in `repository.test.ts` (reopen clears `closed_at`), plus length pre-validation errors in `insertLoopEvent`/`cancelPendingChecksForLoop` mirroring memory's validation style. Commit `test: cover accountability reopen and input guards`.
- [ ] **Step 2:** Full required-checks chain; report any live-integration gaps per AGENTS.md (tools are unit-tested with fakes; live OpenRouter exercise deferred to Phase D acceptance script using configured `OPENROUTER_MODEL`).

## Self-review notes

- Spec coverage: features 1–3 of milestone doc (loops, kinds, clarification) reach the model here; scheduling storage exists but delivery waits for Phase D.
- Type consistency: tool names/order pinned by runtime.test.ts; output `kind` values match module name prefixes used by existing tool-event UI mapping.
