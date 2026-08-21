# Accountability Schema (Milestone 4, Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the accountability data foundation — migrations, generated-style DB types, domain state machine, and profile-scoped repository — with contract and unit tests, replacing the empty `reminders/` boundary with `src/server/accountability/`.

**Architecture:** Person-scoped open loops with an append-only event ledger, future scheduled checks, merged check-in deliveries, and liftable suppressions. All tables follow the memory-migration conventions (RLS enabled, revoked from `public/anon/authenticated`, composite `(id, profile_id)` foreign keys). The repository takes an injected Supabase client so tests run without a database.

**Tech Stack:** PostgreSQL via Supabase migrations, hand-written `Database` types in `src/server/db/types.ts`, zod schemas, vitest with migration-contract tests (assert SQL file contents) and seam-based fakes.

**Spec:** `docs/MILESTONE_4_ACCOUNTABILITY.md` — read it before starting. This plan implements Phase A only.

## Global Constraints

- Node.js 20.9+. Package manager is npm.
- Tests must never touch a live database or network; migration contracts read the `.sql` files as text.
- Every table: `enable row level security`, then `revoke all ... from public, anon, authenticated`. No grants to anon/authenticated.
- Ownership FKs are composite: `(id, profile_id)` unique pairs on parent tables, referenced as `(child_fk_id, child.profile_id)`.
- Append-only ledgers get a `prevent_*_mutation()` trigger raising `'... are immutable'`.
- Never stage private context (`iris_context_pack/`, `.env.local`, personal names).
- Required checks before every commit: `npm run check:secrets`, `npm run check:privacy`, `npm run lint`, `npm run typecheck`, `npm run build`; plus `npm test` green.
- Commit style: conventional prefix, imperative, one sentence (`feat: add accountability schema`).

---

### Task 1: Migration + contract test

**Files:**
- Create: `supabase/migrations/20260829000000_accountability_foundation.sql`
- Test: `src/server/accountability/migration-contract.test.ts`

**Interfaces:**
- Produces: tables `public.open_loops`, `public.loop_events`, `public.scheduled_checks`, `public.checkin_deliveries`, `public.checkin_delivery_items`, `public.loop_suppressions`; enums used verbatim by Tasks 2–4.

- [ ] **Step 1: Write the failing contract test**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  new URL("../../../supabase/migrations/20260829000000_accountability_foundation.sql", import.meta.url),
  "utf8",
);

describe("accountability foundation migration contract", () => {
  it("defines loop, ledger, schedule, delivery, and suppression layers", () => {
    for (const required of [
      "create type public.open_loop_kind",
      "create type public.open_loop_status",
      "create type public.loop_event_kind",
      "create type public.scheduled_check_status",
      "create type public.checkin_delivery_status",
      "create table if not exists public.open_loops",
      "create table if not exists public.loop_events",
      "create table if not exists public.scheduled_checks",
      "create table if not exists public.checkin_deliveries",
      "create table if not exists public.checkin_delivery_items",
      "create table if not exists public.loop_suppressions",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });

  it("keeps person-scoped ownership, immutability, and sweep predicates explicit", () => {
    for (const required of [
      "references public.profiles(id) on delete cascade",
      "foreign key (loop_id, profile_id)",
      "foreign key (delivery_id, profile_id)",
      "foreign key (source_message_id, profile_id, source_thread_id)",
      "prevent_loop_event_mutation",
      "loop_events_immutable",
      "alter table public.open_loops enable row level security",
      "revoke all on table public.open_loops from public, anon, authenticated",
      "where status = 'pending'",
      "kind <> 'routine' or cadence is not null",
      "(status in ('open','paused') and closed_at is null)",
    ]) expect(migration.toLowerCase()).toContain(required.toLowerCase());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/accountability/migration-contract.test.ts`
Expected: FAIL (file-not-found / assertion misses).

- [ ] **Step 3: Write the migration**

```sql
-- Milestone 4, Slice 1: accountability foundation.
-- Open loops are person-scoped, never thread-scoped. Origin thread/message
-- references are deep-link provenance only. Raw history remains untouched.

create type public.open_loop_kind as enum ('commitment', 'routine', 'idea');
create type public.open_loop_status as enum ('open', 'paused', 'done', 'cancelled', 'dropped');
create type public.loop_event_kind as enum (
  'created', 'clarified', 'rescheduled', 'paused', 'resumed',
  'nudged', 'completed', 'cancelled', 'dropped', 'reopened', 'suppressed', 'note'
);
create type public.scheduled_check_status as enum ('pending', 'delivered', 'merged', 'cancelled', 'expired');
create type public.checkin_delivery_status as enum ('pending', 'delivered', 'answered', 'cancelled');

create table if not exists public.open_loops (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 300),
  details text check (details is null or (char_length(details) between 1 and 5000 and details !~ E'\\u0000')),
  kind public.open_loop_kind not null default 'commitment',
  status public.open_loop_status not null default 'open',
  due_at timestamptz,
  cadence jsonb,
  origin_thread_id uuid,
  origin_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  unique (id, profile_id),
  constraint open_loops_status_lifecycle_check check (
    (status in ('open','paused') and closed_at is null)
    or (status in ('done','cancelled','dropped') and closed_at is not null)
  ),
  constraint open_loops_routine_cadence_check check (kind <> 'routine' or cadence is not null)
);
create index if not exists open_loops_profile_status_idx
  on public.open_loops(profile_id, status, updated_at desc);

create table if not exists public.loop_events (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  loop_id uuid not null,
  kind public.loop_event_kind not null,
  detail text check (detail is null or char_length(detail) between 1 and 2000),
  actor text not null default 'agent' check (actor in ('user', 'agent', 'system')),
  source_thread_id uuid,
  source_message_id uuid,
  agent_run_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint loop_events_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict,
  constraint loop_events_thread_fkey
    foreign key (source_thread_id, profile_id)
    references public.threads(id, profile_id) on delete restrict,
  constraint loop_events_message_fkey
    foreign key (source_message_id, profile_id, source_thread_id)
    references public.messages(id, profile_id, thread_id) on delete restrict,
  check ((source_message_id is null) or source_thread_id is not null)
);
create index if not exists loop_events_profile_loop_created_idx
  on public.loop_events(profile_id, loop_id, created_at desc);

create or replace function public.prevent_loop_event_mutation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  raise exception 'Loop events are immutable';
end;
$$;
drop trigger if exists loop_events_immutable on public.loop_events;
create trigger loop_events_immutable
before update or delete on public.loop_events
for each row execute function public.prevent_loop_event_mutation();

create table if not exists public.checkin_deliveries (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  thread_id uuid not null,
  message_id uuid,
  summary text check (summary is null or char_length(summary) between 1 and 4000),
  status public.checkin_delivery_status not null default 'pending',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  answered_at timestamptz,
  unique (id, profile_id),
  constraint checkin_deliveries_thread_fkey
    foreign key (thread_id, profile_id)
    references public.threads(id, profile_id) on delete restrict,
  constraint checkin_deliveries_message_fkey
    foreign key (message_id, profile_id, thread_id)
    references public.messages(id, profile_id, thread_id) on delete set null
);
create index if not exists checkin_deliveries_profile_status_idx
  on public.checkin_deliveries(profile_id, status, created_at desc);

create table if not exists public.checkin_delivery_items (
  delivery_id uuid not null,
  loop_id uuid not null,
  profile_id text not null,
  response text check (response is null or char_length(response) between 1 and 2000),
  responded boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (delivery_id, loop_id),
  constraint checkin_delivery_items_delivery_fkey
    foreign key (delivery_id, profile_id)
    references public.checkin_deliveries(id, profile_id) on delete cascade,
  constraint checkin_delivery_items_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict
);

create table if not exists public.scheduled_checks (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  loop_id uuid not null,
  due_at timestamptz not null,
  status public.scheduled_check_status not null default 'pending',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  escalation_tier integer not null default 0 check (escalation_tier >= 0),
  delivery_id uuid,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancel_reason text check (cancel_reason is null or char_length(cancel_reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (id, profile_id),
  constraint scheduled_checks_loop_fkey
    foreign key (loop_id, profile_id)
    references public.open_loops(id, profile_id) on delete restrict,
  constraint scheduled_checks_delivery_fkey
    foreign key (delivery_id, profile_id)
    references public.checkin_deliveries(id, profile_id) on delete set null,
  constraint scheduled_checks_status_timestamps_check check (
    (status = 'pending' and delivered_at is null and cancelled_at is null)
    or (status in ('delivered','merged') and delivered_at is not null and cancelled_at is null)
    or (status in ('cancelled','expired') and cancelled_at is not null)
  )
);
create index if not exists scheduled_checks_due_idx
  on public.scheduled_checks(due_at) where status = 'pending';

create table if not exists public.loop_suppressions (
  id uuid primary key default gen_random_uuid(),
  profile_id text not null references public.profiles(id) on delete cascade,
  subject text not null check (char_length(subject) between 2 and 200),
  reason text not null default 'User asked Iris to stop following up'
    check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  lifted_at timestamptz,
  unique (id, profile_id)
);
create unique index if not exists loop_suppressions_profile_subject_active_idx
  on public.loop_suppressions(profile_id, subject) where lifted_at is null;

alter table public.open_loops enable row level security;
alter table public.loop_events enable row level security;
alter table public.checkin_deliveries enable row level security;
alter table public.checkin_delivery_items enable row level security;
alter table public.scheduled_checks enable row level security;
alter table public.loop_suppressions enable row level security;
revoke all on table public.open_loops from public, anon, authenticated;
revoke all on table public.loop_events from public, anon, authenticated;
revoke all on table public.checkin_deliveries from public, anon, authenticated;
revoke all on table public.checkin_delivery_items from public, anon, authenticated;
revoke all on table public.scheduled_checks from public, anon, authenticated;
revoke all on table public.loop_suppressions from public, anon, authenticated;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/accountability/migration-contract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260829000000_accountability_foundation.sql src/server/accountability/migration-contract.test.ts
git commit -m "feat: add accountability schema migration"
```

---

### Task 2: Database types

**Files:**
- Modify: `src/server/db/types.ts` (append new table entries inside `Tables`, following the existing per-table Row/Insert/Update shape exactly)

**Interfaces:**
- Consumes: enums from Task 1.
- Produces: `Database["public"]["Tables"]["open_loops" | "loop_events" | "checkin_deliveries" | "checkin_delivery_items" | "scheduled_checks" | "loop_suppressions"]` typed rows used by Task 4's repository.

- [ ] **Step 1: Add the failing usage test** — extend `src/server/accountability/migration-contract.test.ts`:

```ts
import { type Database } from "@/server/db/types";

it("exposes accountability tables in database types", () => {
  const tables: Array<keyof Database["public"]["Tables"]> = [
    "open_loops", "loop_events", "checkin_deliveries",
    "checkin_delivery_items", "scheduled_checks", "loop_suppressions",
  ];
  expect(tables.length).toBe(6);
});
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/server/accountability/migration-contract.test.ts` → FAIL (missing keys).

- [ ] **Step 3: Implement.** Add to `Tables` in `types.ts`, mirroring existing style (e.g. `threads`). Enum columns become string-literal unions matching the SQL enums exactly; timestamps are `string`; `cadence`/`metadata` are `Json | null`.

```ts
open_loops: {
  Row: {
    id: string;
    profile_id: "profile-a" | "profile-b";
    title: string;
    details: string | null;
    kind: "commitment" | "routine" | "idea";
    status: "open" | "paused" | "done" | "cancelled" | "dropped";
    due_at: string | null;
    cadence: Json | null;
    origin_thread_id: string | null;
    origin_message_id: string | null;
    created_at: string;
    updated_at: string;
    closed_at: string | null;
  };
  Insert: {
    id?: string;
    profile_id: "profile-a" | "profile-b";
    title: string;
    details?: string | null;
    kind?: "commitment" | "routine" | "idea";
    status?: "open" | "paused" | "done" | "cancelled" | "dropped";
    due_at?: string | null;
    cadence?: Json | null;
    origin_thread_id?: string | null;
    origin_message_id?: string | null;
    created_at?: string;
    updated_at?: string;
    closed_at?: string | null;
  };
  Update: Partial<OpenLoopsInsertShape>;
  Relationships: [];
};
```

Repeat the same mechanical translation for `loop_events`, `scheduled_checks`, `checkin_deliveries`, `checkin_delivery_items` (composite PK: Insert requires both `delivery_id` and `loop_id`), and `loop_suppressions`, deriving each field's optionality from the SQL defaults/nullability. Define local aliases (like `OpenLoopsInsertShape`) only if needed to keep `Update` lines short; prefer inlining `Partial<{...}>` to match file style.

- [ ] **Step 4: Verify pass + typecheck**

Run: `npx vitest run src/server/accountability/migration-contract.test.ts && npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit** — `git commit -m "feat: type accountability tables"`

---

### Task 3: Domain types + state machine

**Files:**
- Create: `src/server/accountability/types.ts`
- Create: `src/server/accountability/state-machine.ts`
- Test: `src/server/accountability/state-machine.test.ts`

**Interfaces:**
- Produces:
  - `OpenLoopKind = "commitment" | "routine" | "idea"`
  - `OpenLoopStatus = "open" | "paused" | "done" | "cancelled" | "dropped"`
  - `LoopEventKind` (12 values from the SQL enum)
  - `nextStatusOnEvent(current: OpenLoopStatus, event: LoopEventKind): OpenLoopStatus | null` — `null` means illegal transition.
  - `isTerminal(status): boolean`
  - zod: `openLoopKindSchema`, `openLoopStatusSchema`, `cadenceSchema`, `createLoopInputSchema`

- [ ] **Step 1: Failing tests**

```ts
import { describe, expect, it } from "vitest";
import { isTerminal, nextStatusOnEvent } from "./state-machine";

describe("accountability state machine", () => {
  it("closes loops only through closing events", () => {
    expect(nextStatusOnEvent("open", "completed")).toBe("done");
    expect(nextStatusOnEvent("open", "dropped")).toBe("dropped");
    expect(nextStatusOnEvent("paused", "completed")).toBe("done");
  });

  it("keeps non-status events on the current status", () => {
    expect(nextStatusOnEvent("open", "nudged")).toBe("open");
    expect(nextStatusOnEvent("open", "rescheduled")).toBe("open");
    expect(nextStatusOnEvent("open", "note")).toBe("open");
  });

  it("pauses and resumes", () => {
    expect(nextStatusOnEvent("open", "paused")).toBe("paused");
    expect(nextStatusOnEvent("paused", "resumed")).toBe("open");
    expect(nextStatusOnEvent("done", "resumed")).toBeNull();
  });

  it("allows reopening terminal loops and nothing else leaves terminals implicitly", () => {
    expect(nextStatusOnEvent("done", "reopened")).toBe("open");
    expect(nextStatusOnEvent("cancelled", "reopened")).toBe("open");
    expect(nextStatusOnEvent("done", "completed")).toBeNull();
    expect(nextStatusOnEvent("dropped", "nudged")).toBeNull();
  });

  it("flags terminal statuses", () => {
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("open")).toBe(false);
  });
});
```

Also add to `types.test` coverage inside this same file: `createLoopInputSchema.safeParse({ title: "x", kind: "routine" }).success === false` (routine without cadence) and `=== true` with `cadence: { kind: "daily" }`; commitment rejects a supplied cadence.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/server/accountability/state-machine.test.ts` → FAIL.

- [ ] **Step 3: Implement.** `types.ts`: export const arrays of the exact enum values above, zod derives from them via `z.enum(...)`. `cadenceSchema = z.object({ kind: z.enum(["daily","weekly","interval_days"]), timesPerPeriod: z.number().int().min(1).max(7).optional(), daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(), intervalDays: z.number().int().min(1).max(365).optional() }).strict()`. `createLoopInputSchema = z.object({ title: z.string().min(1).max(300), details: z.string().min(1).max(5000).optional(), kind: openLoopKindSchema.default("commitment"), dueAt: z.string().datetime({ offset: true }).optional(), cadence: cadenceSchema.optional() }).superRefine((value, ctx) => { if ((value.kind === "routine") !== (value.cadence !== undefined)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Routine loops require cadence; other kinds must not carry one" }); })`. `state-machine.ts` implements the transition map asserted above with a single `Record<OpenLoopStatus, Partial<Record<LoopEventKind, OpenLoopStatus>>>` lookup; unknown combinations return `null`.

- [ ] **Step 4: Verify pass** — `npx vitest run src/server/accountability/state-machine.test.ts` → PASS.

- [ ] **Step 5: Commit** — `git commit -m "feat: add accountability domain state machine"`

---

### Task 4: Repository

**Files:**
- Create: `src/server/accountability/repository.ts`
- Test: `src/server/accountability/repository.test.ts`

**Interfaces:**
- Consumes: injected `SupabaseClient` typed against `Database` from `@/server/db/client` exports (mirror how `src/server/memory/repository.ts` receives its client — read that file first and copy its DI and error-handling conventions).
- Produces: `createAccountabilityRepository(client): AccountabilityRepository` with methods:
  - `listOpenLoops(profileId, filter?: { statuses?: OpenLoopStatus[] }): Promise<OpenLoopRow[]>`
  - `getOpenLoop(profileId, loopId): Promise<OpenLoopRow | null>`
  - `insertOpenLoop(input): Promise<OpenLoopRow>` (validates via `createLoopInputSchema`)
  - `updateOpenLoopStatus(profileId, loopId, expectedUpdatedAt, patch): Promise<OpenLoopRow>` — optimistic concurrency on `updated_at`, throws `StaleOpenLoopRevisionError` on mismatch (mirror memory's stale-revision error naming)
  - `insertLoopEvent(profileId, input): Promise<LoopEventRow>`
  - `listDueChecks(profileId, nowIso, limit): Promise<ScheduledCheckRow[]>` — `status='pending' and due_at <= nowIso order by due_at asc limit N`
  - `insertScheduledCheck(profileId, input): Promise<ScheduledCheckRow>`
  - `cancelPendingChecksForLoop(profileId, loopId, reason): Promise<number>` — returns affected count

- [ ] **Step 1: Read conventions** — `src/server/memory/repository.ts` (DI shape, error classes, row mapping) and its test fake pattern in `repository.test.ts`.

- [ ] **Step 2: Write failing tests** for `insertOpenLoop` validation rejection (schema), optimistic-concurrency stale throw, `listDueChecks` filtering/ordering, and `cancelPendingChecksForLoop` returning count — using the same fake-client style as the memory repository tests.

- [ ] **Step 3: Run to verify failure**, **Step 4: implement** all eight methods against the builder API exactly as memory does (`.from("open_loops").select().eq("profile_id", ...)`, `.update(...).eq("id", ...).eq("profile_id", ...)` etc.).

- [ ] **Step 5: Verify pass** — `npx vitest run src/server/accountability/repository.test.ts` → PASS.

- [ ] **Step 6: Commit** — `git commit -m "feat: add accountability repository"`

---

### Task 5: Boundary rename + full verification

**Files:**
- Delete: `src/server/reminders/README.md` (whole directory)
- Create: `src/server/accountability/README.md`

**Steps:**

- [ ] **Step 1:** Write README: one paragraph stating this module owns open loops, scheduled checks, deliveries, and suppressions; chat-first UX; person-scoped not thread-scoped; link `docs/MILESTONE_4_ACCOUNTABILITY.md`. Then `git rm -r src/server/reminders && git add src/server/accountability/README.md`.
- [ ] **Step 2: Full suite + checks**

```bash
npm test && npm run check:secrets && npm run check:privacy && npm run lint && npm run typecheck && npm run build
```

Expected: all green.

- [ ] **Step 3: Commit** — `git commit -m "chore: rename reminders boundary to accountability"` and push the branch.

---

## Self-review notes

- Spec coverage: Phase A scope = schema (Task 1), types (Task 2), domain/state machine (Task 3), repository (Task 4), boundary hygiene (Task 5). Later phases have their own plans.
- Type consistency: enum unions identical across SQL (Task 1), DB types (Task 2), and domain types (Task 3) — `"open" | "paused" | "done" | "cancelled" | "dropped"`, 12 event kinds.
- Live-LLM note: Phase A needs no model calls. Live acceptance harness arrives with Phase D.
