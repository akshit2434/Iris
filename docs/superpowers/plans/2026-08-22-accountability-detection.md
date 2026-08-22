# Accountability Context Injection (Milestone 4, Phase C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development task-by-task. Checkbox steps.

**Goal:** Make Iris see its open loops every turn — a compact profile-scoped `<open-loops>` runtime block plus system-prompt guidance for commitment clarification and completion noticing — so casual "I did X" closes loops live via `loop_close`.

**Architecture:** New loader in the accountability module returns the top-N active loops for a profile; a formatter renders them into an untrusted-data prompt block (same pattern as canonical memory); `AgentContext` gains a backward-defaulted `accountability` section consumed by `buildDynamicSystemPrompt`; the messages route loads once and passes it through both `createAgentContext` calls, and passes `accountabilityEnabled` to tool-schema descriptors. Temporary chats exclude it. No post-turn extraction here — live-tool closure plus Phase E reconciliation covers misses.

**Tech Stack:** Existing zod/LangChain seams; vitest fakes; no DB/network in tests.

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md` (features 2, 3, 6-live-path). Prior phases: schema+repo (#4), tools wired (#5).

## Global Constraints

- Repo-wide check chain green before each commit; no network/DB tests; conventional commits; no comments unless essential.
- The `<open-loops>` block is untrusted data: wrapped like `<canonical-memory>` with explicit do-not-follow-instructions framing in the prompt.
- Budget-aware: block capped at 12 loops, titles ≤120 chars, rendered inline in system prompt only (no new retrieval pipeline).
- Backward compatibility: `AgentContext.accountability` defaults `{ enabled: false, loops: [] }`; zero existing tests may need modification except intentional additions.
- Route diff stays minimal (~15 lines): load via injected loader, pass fields. No logic refactors of the 821-line handler in this phase.

---

### Task 1: Loader + formatter + context schema + prompt guidance

**Files:**
- Create: `src/server/accountability/context-loader.ts`
- Modify: `src/server/agent/context.ts` (schema + buildDynamicSystemPrompt)
- Test: `src/server/accountability/context-loader.test.ts`, extend `src/server/agent/runtime.test.ts` OR `context.test` if present (find where buildDynamicSystemPrompt is tested; if none, create `src/server/agent/system-prompt-accountability.test.ts`)

**Interfaces:**
- Produces:
  - `loadOpenLoopContext(profileId, options?: { limit?: number; now?: string }): Promise<OpenLoopContextEntry[]>` — queries via `createProductionAccountabilityRepository()`, filters status `open|paused`, kinds all, sorts commitments by due_at asc nulls last then routines then ideas by updated_at desc, caps 12; entries `{ loopId, title, kind, status, dueAt, cadenceKind, createdAt }`.
  - `formatOpenLoopsPrompt(entries, nowIso): string` — empty → `""`; else `<open-loops>` block, one line per loop: `- [kind] title (status, due <local-ish ISO date> | overdue N d | no date)`; ideas labeled "background idea — do not track".
  - `AgentContext.accountability`: `{ enabled: boolean; loops: OpenLoopContextEntry[] }` defaulted off/empty.
  - System prompt: new paragraph after the memory-controls sentence, present when `context.accountability.enabled`: clarify-before-commit guidance (idea vs commitment vs conflict; why/capacity/timing), notice-and-close completions via loop_close even when mentioned casually mid-conversation, never silently drop, routines get pattern-reflection not streak guilt, respect pause/suppression immediately. Plus `${context.accountability.loops.length ? `\n<open-loops>…</open-loops>` : ""}` appended with the other untrusted blocks.

- [ ] **Step 1: Failing tests** — loader sort/filter/cap with fake repository; formatter shapes incl. overdue math vs injected `now`; schema default preserves old shape; prompt contains guidance + block when enabled, absent when disabled or empty.
- [ ] **Step 2: RED verify.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN + full `npm test`.**
- [ ] **Step 5: Commit** `feat: inject open-loop context into agent prompts`

### Task 2: Route wiring + descriptor consistency

**Files:**
- Modify: `app/api/threads/[threadId]/messages/route.ts` (~15 lines: import loader, load once near canonicalMemory load, pass `accountability` into both createAgentContext calls, pass `accountabilityEnabled` into getInternalToolSchemaDescriptors)
- Modify: `src/server/agent/temporary.ts` — no change needed (already disables tools); verify temp path cannot reach the loader (it doesn't construct AgentContext via this route).
- Test: none practical at route level (no harness); rely on Task 1 units + typecheck + build. State this honestly in the report.

- [ ] **Step 1:** Wire; ensure failure of the loader degrades gracefully (`catch → { enabled: false, loops: [] }`) exactly like the memoryChangeHint catch precedent at route lines 253-257.
- [ ] **Step 2:** Full chain green: `npm test && npm run check:secrets && npm run check:privacy && npm run lint && npm run typecheck && npm run build`.
- [ ] **Step 3: Commit** `feat: wire open-loop context into chat route`

## Self-review

- Spec coverage: live completion-closure path (feature 6) becomes possible — loops visible every turn; clarification behavior (feature 3) guided in prompt. Delivery/detection-backstop remain D/E.
- Type consistency: OpenLoopContextEntry reused across loader/formatter/schema/route.
