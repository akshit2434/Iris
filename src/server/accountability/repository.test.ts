import { describe, expect, it } from "vitest";
import { createAccountabilityRepository, normalizeSuppressionSubject, StaleOpenLoopRevisionError } from "@/server/accountability/repository";

function fakeAccountabilityDatabase(extraScheduledChecks: Record<string, unknown>[] = []) {
  const calls: Array<{ operation: string; table?: string; field?: string; value?: unknown; params?: unknown }> = [];
  const insertedAt = "2026-08-22T12:00:00.000Z";
  const rows: Record<string, Record<string, unknown>[]> = {
    open_loops: [
      { id: "loop-a", profile_id: "profile-a", title: "Renew passport", details: null, kind: "commitment", status: "open", due_at: "2026-09-01T09:00:00.000Z", cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-20T10:00:00.000Z", updated_at: "2026-08-20T10:00:00.000Z", closed_at: null },
      { id: "loop-done", profile_id: "profile-a", title: "File taxes", details: null, kind: "commitment", status: "done", due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-19T10:00:00.000Z", updated_at: "2026-08-21T10:00:00.000Z", closed_at: "2026-08-21T10:00:00.000Z" },
      { id: "loop-b", profile_id: "profile-b", title: "Book dentist", details: null, kind: "idea", status: "open", due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-18T10:00:00.000Z", updated_at: "2026-08-18T10:00:00.000Z", closed_at: null },
    ],
    scheduled_checks: [
      { id: "check-due-late", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T10:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-due-early", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T08:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-future", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-23T09:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-other-loop", profile_id: "profile-a", loop_id: "loop-done", due_at: "2026-08-22T06:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-cancelled", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T07:00:00.000Z", status: "cancelled", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: "2026-08-21T15:00:00.000Z", cancel_reason: "superseded", claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-b", profile_id: "profile-b", loop_id: "loop-b", due_at: "2026-08-22T05:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null, created_at: "2026-08-21T10:00:00.000Z" },
      ...extraScheduledChecks,
    ],
    loop_events: [],
    checkin_deliveries: [],
    loop_suppressions: [],
  };
  const defaults: Record<string, Record<string, unknown>> = {
    open_loops: { status: "open", details: null, due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, closed_at: null },
    loop_events: { detail: null, actor: "agent", source_thread_id: null, source_message_id: null, agent_run_id: null, metadata: {} },
    loop_suppressions: { lifted_at: null },
    scheduled_checks: { status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null },
    checkin_deliveries: { message_id: null, summary: null, status: "pending", delivered_at: null, answered_at: null },
  };
  let generated = 0;
  const at = (row: unknown, field: string) => (row as Record<string, unknown>)[field];
  const chain = (table: string) => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    let filtered = [...rows[table]];
    let pendingPatch: Record<string, unknown> | null = null;
    const applyPendingPatch = () => {
      if (!pendingPatch) return;
      const targets = new Set(filtered);
      const patchedRows: Record<string, unknown>[] = [];
      rows[table] = rows[table].map((row) => {
        if (!targets.has(row)) return row;
        const patched = { ...row, ...pendingPatch };
        patchedRows.push(patched);
        return patched;
      });
      filtered = patchedRows;
      pendingPatch = null;
    };
    builder.select = () => builder;
    builder.eq = (field: unknown, value: unknown) => { calls.push({ operation: "eq", table, field: String(field), value }); filtered = filtered.filter((row) => at(row, String(field)) === value); return builder; };
    builder.in = (field: unknown, values: unknown) => { calls.push({ operation: "in", table, field: String(field), value: values }); filtered = filtered.filter((row) => (values as unknown[]).includes(at(row, String(field)))); return builder; };
    builder.lte = (field: unknown, value: unknown) => { calls.push({ operation: "lte", table, field: String(field), value }); filtered = filtered.filter((row) => String(at(row, String(field))) <= String(value)); return builder; };
    builder.is = (field: unknown, value: unknown) => { calls.push({ operation: "is", table, field: String(field), value }); filtered = filtered.filter((row) => at(row, String(field)) === value); return builder; };
    builder.lt = (field: unknown, value: unknown) => { calls.push({ operation: "lt", table, field: String(field), value }); filtered = filtered.filter((row) => String(at(row, String(field))) < String(value)); return builder; };
    builder.or = (expr: unknown) => {
      calls.push({ operation: "or", table, value: expr });
      const clauses = String(expr).split(",").map((clause) => /^(.+)\.(is|lt)\.(.+)$/.exec(clause));
      filtered = filtered.filter((row) => clauses.some((match) => {
        if (!match) return false;
        const [, field, op, raw] = match;
        const cell = at(row, field);
        if (op === "is") return cell === null || cell === undefined ? raw === "null" : false;
        return String(cell) < raw;
      }));
      return builder;
    };
    builder.order = (field: unknown, options: unknown) => { calls.push({ operation: "order", table, field: String(field), value: options }); const direction = (options as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1; filtered = [...filtered].sort((left, right) => String(at(left, String(field))).localeCompare(String(at(right, String(field)))) * direction); return builder; };
    builder.limit = (count: unknown) => { calls.push({ operation: "limit", table, value: count }); filtered = filtered.slice(0, Number(count)); return builder; };
    builder.maybeSingle = () => Promise.resolve({ data: filtered[0] ?? null, error: null });
    builder.single = () => Promise.resolve(filtered.length > 0 ? { data: filtered[0], error: null } : { data: null, error: { message: "no rows returned" } });
    builder.insert = (value: unknown) => {
      calls.push({ operation: "insert", table, params: value });
      generated += 1;
      const record = { id: `generated-${generated}`, created_at: insertedAt, updated_at: insertedAt, ...(defaults[table] ?? {}), ...(value as Record<string, unknown>) };
      rows[table] = [...rows[table], record];
      filtered = [record];
      return builder;
    };
    builder.update = (value: unknown) => {
      calls.push({ operation: "update", table, params: value });
      pendingPatch = value as Record<string, unknown>;
      return builder;
    };
    builder.then = (...args: unknown[]) => { applyPendingPatch(); const resolve = args[0] as ((value: unknown) => unknown) | undefined; const promise = Promise.resolve({ data: filtered, error: null }); return resolve ? promise.then(resolve) : promise; };
    return builder;
  };
  return {
    database: {
      from(table: string) { calls.push({ operation: "from", table }); return chain(table); },
    },
    calls,
    rows,
  };
}

describe("accountability repository", () => {
  it("scopes open loop reads to the requested profile", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.listOpenLoops("profile-zzz" as never)).rejects.toThrow(/profile scope/i);
    await expect(repository.listOpenLoops("profile-a")).resolves.toHaveLength(2);
    await expect(repository.listOpenLoops("profile-a", { statuses: ["open"] })).resolves.toHaveLength(1);
    await expect(repository.listOpenLoops("profile-b")).resolves.toMatchObject([{ id: "loop-b" }]);
    expect(calls).toContainEqual({ operation: "eq", table: "open_loops", field: "profile_id", value: "profile-a" });
    expect(calls).toContainEqual({ operation: "in", table: "open_loops", field: "status", value: ["open"] });
    await expect(repository.getOpenLoop("profile-a", "loop-a")).resolves.toMatchObject({ id: "loop-a", profileId: "profile-a", title: "Renew passport", status: "open" });
    await expect(repository.getOpenLoop("profile-b", "loop-a")).resolves.toBeNull();
  });

  it("validates create input against the domain schema before touching the database", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertOpenLoop({ profileId: "profile-a", title: "" })).rejects.toThrow();
    await expect(repository.insertOpenLoop({ profileId: "profile-a", title: "Ship release", kind: "routine" })).rejects.toThrow(/cadence/i);
    expect(calls).toHaveLength(0);
    await expect(repository.insertOpenLoop({ profileId: "profile-b", title: "Water plants", dueAt: "2026-09-02T09:00:00.000Z" })).resolves.toMatchObject({
      profileId: "profile-b",
      title: "Water plants",
      kind: "commitment",
      status: "open",
      dueAt: "2026-09-02T09:00:00.000Z",
      cadence: null,
    });
    expect(calls.filter((call) => call.operation === "insert")).toHaveLength(1);
  });

  it("applies state machine transitions guarded by optimistic concurrency", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const result = await repository.updateOpenLoopStatus("profile-a", "loop-a", "2026-08-20T10:00:00.000Z", { event: "completed" });
    expect(result).toMatchObject({ id: "loop-a", status: "done" });
    expect(result.closedAt).not.toBeNull();
    expect(result.updatedAt).not.toBe("2026-08-20T10:00:00.000Z");
    expect(calls.find((call) => call.operation === "update")?.params).toMatchObject({ status: "done", closed_at: result.closedAt });
    expect(calls).toContainEqual({ operation: "eq", table: "open_loops", field: "updated_at", value: "2026-08-20T10:00:00.000Z" });
    expect(calls).toContainEqual({ operation: "eq", table: "open_loops", field: "id", value: "loop-a" });
    expect(calls).toContainEqual({ operation: "eq", table: "open_loops", field: "profile_id", value: "profile-a" });
  });

  it("rewrites due_at inside the guarded transition when the patch carries one and leaves it alone otherwise", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const rescheduled = await repository.updateOpenLoopStatus("profile-a", "loop-a", "2026-08-20T10:00:00.000Z", { event: "rescheduled", dueAt: "2026-09-10T09:00:00.000Z" });
    expect(rescheduled).toMatchObject({ id: "loop-a", status: "open", dueAt: "2026-09-10T09:00:00.000Z" });
    expect(calls.find((call) => call.operation === "update")?.params).toMatchObject({ status: "open", due_at: "2026-09-10T09:00:00.000Z" });
    const untouched = await repository.updateOpenLoopStatus("profile-a", "loop-a", rescheduled.updatedAt, { event: "nudged" });
    expect(untouched.dueAt).toBe("2026-09-10T09:00:00.000Z");
    expect(calls.filter((call) => call.operation === "update").at(-1)?.params).not.toHaveProperty("due_at");
  });

  it("reopens a closed loop and clears closed_at", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const reopened = await repository.updateOpenLoopStatus("profile-a", "loop-done", "2026-08-21T10:00:00.000Z", { event: "reopened" });
    expect(reopened).toMatchObject({ id: "loop-done", status: "open" });
    expect(reopened.closedAt).toBeNull();
    expect(calls.find((call) => call.operation === "update")?.params).toMatchObject({ status: "open", closed_at: null });
  });

  it("throws StaleOpenLoopRevisionError on revision mismatch and clear errors otherwise", async () => {
    const { database } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.updateOpenLoopStatus("profile-a", "loop-a", "2020-01-01T00:00:00.000Z", { event: "completed" })).rejects.toBeInstanceOf(StaleOpenLoopRevisionError);
    await expect(repository.updateOpenLoopStatus("profile-a", "missing-loop", "2026-08-20T10:00:00.000Z", { event: "completed" })).rejects.toThrow(/not found/i);
    await expect(repository.updateOpenLoopStatus("profile-a", "loop-done", "2026-08-21T10:00:00.000Z", { event: "completed" })).rejects.toThrow(/illegal open loop transition/i);
  });

  it("lists pending due checks ordered ascending under a hard limit", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.listDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 2)).resolves.toMatchObject([
      { id: "check-other-loop" },
      { id: "check-due-early" },
    ]);
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "profile_id", value: "profile-a" });
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "status", value: "pending" });
    expect(calls).toContainEqual({ operation: "lte", table: "scheduled_checks", field: "due_at", value: "2026-08-22T12:00:00.000Z" });
    expect(calls).toContainEqual({ operation: "limit", table: "scheduled_checks", value: 2 });
    await expect(repository.listDueChecks("profile-b", "2026-08-22T12:00:00.000Z", 5)).resolves.toMatchObject([{ id: "check-b" }]);
  });

  it("cancels only pending checks for a loop and reports the affected count", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.cancelPendingChecksForLoop("profile-a", "loop-a", "Loop completed by user")).resolves.toBe(3);
    expect(calls.find((call) => call.operation === "update")?.params).toMatchObject({ status: "cancelled", cancel_reason: "Loop completed by user" });
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "loop_id", value: "loop-a" });
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "status", value: "pending" });
    await expect(repository.listDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 5)).resolves.toMatchObject([{ id: "check-other-loop" }]);
    await expect(repository.cancelPendingChecksForLoop("profile-a", "loop-a", "Loop completed by user")).resolves.toBe(0);
  });

  it("pre-validates loop event detail and cancel reason lengths before touching the database", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertLoopEvent("profile-a", { loopId: "loop-a", kind: "note", detail: "x".repeat(2001) })).rejects.toThrow(/limited to 2,000 characters/i);
    await expect(repository.cancelPendingChecksForLoop("profile-a", "loop-a", "   ")).rejects.toThrow(/between 1 and 500/i);
    await expect(repository.cancelPendingChecksForLoop("profile-a", "loop-a", "y".repeat(501))).rejects.toThrow(/between 1 and 500/i);
    expect(calls).toHaveLength(0);
    await expect(repository.insertLoopEvent("profile-a", { loopId: "loop-a", kind: "note", detail: "x".repeat(2000) })).resolves.toMatchObject({ detail: "x".repeat(2000) });
    await expect(repository.cancelPendingChecksForLoop("profile-a", "loop-a", "Loop completed by user")).resolves.toBe(3);
  });

  it("records loop events and scheduled checks with mapped columns", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertLoopEvent("profile-a", { loopId: "loop-a", kind: "note", detail: "checked in" })).resolves.toMatchObject({
      profileId: "profile-a",
      loopId: "loop-a",
      kind: "note",
      detail: "checked in",
      actor: "agent",
      metadata: {},
    });
    expect(calls.some((call) => call.operation === "insert" && call.table === "loop_events")).toBe(true);
    calls.length = 0;
    await expect(repository.insertScheduledCheck("profile-a", { loopId: "loop-a", dueAt: "2026-08-25T09:00:00.000Z" })).resolves.toMatchObject({
      profileId: "profile-a",
      loopId: "loop-a",
      dueAt: "2026-08-25T09:00:00.000Z",
      status: "pending",
      attemptCount: 0,
      escalationTier: 0,
    });
    expect(calls.some((call) => call.operation === "insert" && call.table === "scheduled_checks")).toBe(true);
  });

  it("inherits the highest prior attempt count when rescheduling a loop's check", async () => {
    const { database, calls } = fakeAccountabilityDatabase([
      { id: "check-prior", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T09:00:00.000Z", status: "delivered", attempt_count: 3, escalation_tier: 2, delivery_id: "delivery-old", delivered_at: "2026-08-22T09:30:00.000Z", cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
    ]);
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertScheduledCheck("profile-a", { loopId: "loop-a", dueAt: "2026-08-25T09:00:00.000Z" })).resolves.toMatchObject({
      loopId: "loop-a",
      status: "pending",
      attemptCount: 3,
      escalationTier: 3,
    });
    expect(calls.find((call) => call.operation === "insert" && call.table === "scheduled_checks")?.params).toMatchObject({ attempt_count: 3, escalation_tier: 3 });
  });

  it("carries a matching escalation tier into rescheduled checks so repeated asks stay varied", async () => {
    const { database } = fakeAccountabilityDatabase([
      { id: "check-prior-two", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-21T09:00:00.000Z", status: "delivered", attempt_count: 2, escalation_tier: 2, delivery_id: "delivery-old", delivered_at: "2026-08-21T09:30:00.000Z", cancelled_at: null, cancel_reason: null, created_at: "2026-08-20T10:00:00.000Z" },
      { id: "check-prior-one", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-20T09:00:00.000Z", status: "cancelled", attempt_count: 1, escalation_tier: 1, delivery_id: "delivery-old", delivered_at: "2026-08-20T09:30:00.000Z", cancelled_at: "2026-08-20T15:00:00.000Z", cancel_reason: "superseded", created_at: "2026-08-19T10:00:00.000Z" },
    ]);
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertScheduledCheck("profile-a", { loopId: "loop-a", dueAt: "2026-08-25T09:00:00.000Z" })).resolves.toMatchObject({
      attemptCount: 2,
      escalationTier: 2,
    });
  });

  it("joins pending due checks with their parent loops regardless of loop status", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.listDueChecksWithLoops("profile-a", "2026-08-22T12:00:00.000Z", 10)).resolves.toMatchObject([
      { check: { id: "check-other-loop" }, loop: { id: "loop-done", status: "done" } },
      { check: { id: "check-due-early" }, loop: { id: "loop-a", status: "open" } },
      { check: { id: "check-due-late" }, loop: { id: "loop-a", status: "open" } },
    ]);
    expect(calls.filter((call) => call.operation === "from")).toHaveLength(2);
    expect(calls).toContainEqual({ operation: "in", table: "open_loops", field: "id", value: ["loop-done", "loop-a"] });
    await expect(repository.listDueChecksWithLoops("profile-a", "2026-08-22T12:00:00.000Z", 1)).resolves.toMatchObject([
      { check: { id: "check-other-loop" }, loop: { id: "loop-done" } },
    ]);
    await expect(repository.listDueChecksWithLoops("profile-b", "2026-08-22T12:00:00.000Z", 10)).resolves.toMatchObject([
      { check: { id: "check-b" }, loop: { id: "loop-b" } },
    ]);
  });

  it("claims due pending checks atomically and returns them joined with their loops", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const claimed = await repository.claimDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 2);
    expect(claimed.map((pair) => pair.check.id)).toEqual(["check-other-loop", "check-due-early"]);
    for (const pair of claimed) {
      expect(pair.check.claimedAt).toBe("2026-08-22T12:00:00.000Z");
      expect(pair.check.status).toBe("pending");
      expect(pair.loop.id).toBe(pair.check.loopId);
    }
    const update = calls.find((call) => call.operation === "update");
    expect(update).toMatchObject({ table: "scheduled_checks", params: { claimed_at: "2026-08-22T12:00:00.000Z" } });
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "status", value: "pending" });
    expect(calls).toContainEqual({ operation: "lte", table: "scheduled_checks", field: "due_at", value: "2026-08-22T12:00:00.000Z" });
    expect(calls.find((call) => call.operation === "or")?.value).toContain("claimed_at.is.null");
    expect(calls.find((call) => call.operation === "or")?.value).toContain("claimed_at.lt.2026-08-22T11:50");
    expect(calls).toContainEqual({ operation: "limit", table: "scheduled_checks", value: 2 });
    await expect(repository.listDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 5)).resolves.toMatchObject([
      { id: "check-other-loop" },
      { id: "check-due-early" },
      { id: "check-due-late" },
    ]);
    await expect(repository.claimDueChecks("profile-zzz" as never, "2026-08-22T12:00:00.000Z", 2)).rejects.toThrow(/profile scope/i);
    await expect(repository.claimDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 0)).rejects.toThrow(/positive integers/i);
    await expect(repository.claimDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 5)).resolves.toHaveLength(1);
  });

  it("reclaims stale claims only after the stale window while fresh claims stay invisible", async () => {
    const { database, calls } = fakeAccountabilityDatabase([
      { id: "check-fresh-claim", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T07:30:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: "2026-08-22T11:55:00.000Z", created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-stale-claim", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T07:00:00.000Z", status: "pending", attempt_count: 1, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: "2026-08-22T11:40:00.000Z", created_at: "2026-08-21T10:00:00.000Z" },
    ]);
    const repository = createAccountabilityRepository(database as never);
    const claimed = await repository.claimDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 10);
    expect(claimed.map((pair) => pair.check.id)).toEqual(["check-other-loop", "check-stale-claim", "check-due-early", "check-due-late"]);
    const stalePair = claimed.find((pair) => pair.check.id === "check-stale-claim");
    expect(stalePair?.check.attemptCount).toBe(1);
    expect(stalePair?.check.claimedAt).toBe("2026-08-22T12:00:00.000Z");
    expect(claimed.some((pair) => pair.check.id === "check-fresh-claim")).toBe(false);
    const orCall = calls.find((call) => call.operation === "or");
    expect(String(orCall?.value)).toContain("claimed_at.lt.2026-08-22T11:50:00.000Z");
  });

  it("clears the claim when a check is marked delivered or cancelled", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await repository.claimDueChecks("profile-a", "2026-08-22T12:00:00.000Z", 10);
    const delivered = await repository.markCheckDelivered("profile-a", "check-due-early", {
      deliveryId: "delivery-x",
      deliveredAt: "2026-08-22T12:01:00.000Z",
      attemptCount: 1,
      escalationTier: 0,
    });
    expect(delivered.claimedAt).toBeNull();
    const deliveredPatch = calls.filter((call) => call.operation === "update").at(-1)?.params as Record<string, unknown>;
    expect(deliveredPatch).toMatchObject({ status: "delivered", claimed_at: null });
    await repository.cancelPendingChecksForLoop("profile-a", "loop-a", "Loop completed by user");
    const cancelPatch = calls.filter((call) => call.operation === "update").at(-1)?.params as Record<string, unknown>;
    expect(cancelPatch).toMatchObject({ status: "cancelled", claimed_at: null });
  });

  it("cancels orphaned pending deliveries past the retry window with a sweep_retry marker", async () => {
    const { database, calls, rows } = fakeAccountabilityDatabase();
    rows.checkin_deliveries.push(
      { id: "delivery-orphan", profile_id: "profile-a", thread_id: "thread-1", message_id: null, summary: null, status: "pending", created_at: "2026-08-22T11:00:00.000Z", delivered_at: null, answered_at: null },
      { id: "delivery-fresh", profile_id: "profile-a", thread_id: "thread-1", message_id: null, summary: null, status: "pending", created_at: "2026-08-22T11:45:00.000Z", delivered_at: null, answered_at: null },
      { id: "delivery-linked", profile_id: "profile-a", thread_id: "thread-1", message_id: "message-1", summary: null, status: "pending", created_at: "2026-08-22T10:00:00.000Z", delivered_at: null, answered_at: null },
      { id: "delivery-other-profile", profile_id: "profile-b", thread_id: "thread-2", message_id: null, summary: null, status: "pending", created_at: "2026-08-22T10:00:00.000Z", delivered_at: null, answered_at: null },
    );
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.cancelOrphanPendingDeliveries("profile-a", "2026-08-22T12:00:00.000Z")).resolves.toBe(1);
    const update = calls.find((call) => call.operation === "update");
    expect(update).toMatchObject({ table: "checkin_deliveries", params: { status: "cancelled", summary: "sweep_retry" } });
    expect(calls).toContainEqual({ operation: "is", table: "checkin_deliveries", field: "message_id", value: null });
    expect(calls).toContainEqual({ operation: "lt", table: "checkin_deliveries", field: "created_at", value: "2026-08-22T11:30:00.000Z" });
    const byId = (id: string) => rows.checkin_deliveries.find((row) => row.id === id);
    expect(byId("delivery-orphan")).toMatchObject({ status: "cancelled", summary: "sweep_retry" });
    expect(byId("delivery-fresh")).toMatchObject({ status: "pending" });
    expect(byId("delivery-linked")).toMatchObject({ status: "pending" });
    expect(byId("delivery-other-profile")).toMatchObject({ status: "pending" });
    await expect(repository.cancelOrphanPendingDeliveries("profile-zzz" as never, "2026-08-22T12:00:00.000Z")).rejects.toThrow(/profile scope/i);
  });

  it("transitions a pending check to delivered exactly once with delivery linkage and counters", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const delivered = await repository.markCheckDelivered("profile-a", "check-due-early", {
      deliveryId: "delivery-x",
      deliveredAt: "2026-08-22T12:00:00.000Z",
      attemptCount: 2,
      escalationTier: 1,
    });
    expect(delivered).toMatchObject({ id: "check-due-early", status: "delivered", deliveryId: "delivery-x", attemptCount: 2, escalationTier: 1 });
    expect(delivered.deliveredAt).toBe("2026-08-22T12:00:00.000Z");
    expect(calls.find((call) => call.operation === "update")?.params).toMatchObject({
      status: "delivered",
      delivery_id: "delivery-x",
      attempt_count: 2,
      escalation_tier: 1,
    });
    expect(calls).toContainEqual({ operation: "eq", table: "scheduled_checks", field: "status", value: "pending" });
    await expect(repository.markCheckDelivered("profile-a", "check-due-early", {
      deliveryId: "delivery-y",
      deliveredAt: "2026-08-22T13:00:00.000Z",
      attemptCount: 3,
      escalationTier: 2,
    })).rejects.toThrow(/pending/i);
    await expect(repository.markCheckDelivered("profile-zzz" as never, "check-due-early", {
      deliveryId: "delivery-x",
      deliveredAt: "2026-08-22T12:00:00.000Z",
      attemptCount: 2,
      escalationTier: 1,
    })).rejects.toThrow(/profile scope/i);
  });

  it("creates pending deliveries and completes them with their message linkage", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const pending = await repository.insertDelivery("profile-a", { threadId: "thread-1" });
    expect(pending).toMatchObject({ profileId: "profile-a", threadId: "thread-1", status: "pending", messageId: null });
    expect(calls.some((call) => call.operation === "insert" && call.table === "checkin_deliveries")).toBe(true);
    const completed = await repository.markDeliveryDelivered("profile-a", pending.id, { messageId: "message-9" });
    expect(completed).toMatchObject({ id: pending.id, status: "delivered", messageId: "message-9" });
    expect(completed.deliveredAt).not.toBeNull();
    await expect(repository.markDeliveryDelivered("profile-a", pending.id, { messageId: "message-10" })).rejects.toThrow(/pending/i);
  });

  it("normalizes suppression subjects and validates bounds before touching the database", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertLoopSuppression("profile-a", { subject: " a " })).rejects.toThrow(/between 2 and 200/i);
    await expect(repository.insertLoopSuppression("profile-a", { subject: ` ${"x".repeat(201)} ` })).rejects.toThrow(/between 2 and 200/i);
    await expect(repository.insertLoopSuppression("profile-a", { subject: "sleep before midnight", reason: ` ${"y".repeat(501)} ` })).rejects.toThrow(/between 1 and 500/i);
    expect(calls.filter((call) => call.table === "loop_suppressions")).toHaveLength(0);
    const created = await repository.insertLoopSuppression("profile-a", { subject: "  Sleep   BEFORE   midnight  ", reason: " User asked to stop " });
    expect(created).toMatchObject({
      profileId: "profile-a",
      subject: "sleep before midnight",
      reason: "User asked to stop",
      liftedAt: null,
    });
    expect(calls.find((call) => call.operation === "insert" && call.table === "loop_suppressions")?.params).toMatchObject({ subject: "sleep before midnight" });
    expect(normalizeSuppressionSubject("\tSleep\tbefore\nmidnight ")).toBe("sleep before midnight");
  });

  it("updates the reason of the active row instead of duplicating on conflict", async () => {
    const { database, calls, rows } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    const first = await repository.insertLoopSuppression("profile-a", { subject: "Sleep before midnight" });
    const second = await repository.insertLoopSuppression("profile-a", { subject: "sleep   before midnight", reason: "Genuinely changed routine" });
    expect(second.id).toBe(first.id);
    expect(rows.loop_suppressions).toHaveLength(1);
    expect(rows.loop_suppressions[0]).toMatchObject({ subject: "sleep before midnight", reason: "Genuinely changed routine", lifted_at: null });
    const update = calls.filter((call) => call.operation === "update" && call.table === "loop_suppressions").at(-1);
    expect(update?.params).toEqual({ reason: "Genuinely changed routine" });
    expect(calls).toContainEqual({ operation: "is", table: "loop_suppressions", field: "lifted_at", value: null });
  });

  it("defaults the suppression reason when none is provided", async () => {
    const { database, rows } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.insertLoopSuppression("profile-a", { subject: "Dentist booking" })).resolves.toMatchObject({
      subject: "dentist booking",
      reason: "User asked Iris to stop following up",
    });
    expect(rows.loop_suppressions).toHaveLength(1);
  });

  it("lifts only active rows for the normalized subject and reports the count", async () => {
    const { database, calls } = fakeAccountabilityDatabase();
    const repository = createAccountabilityRepository(database as never);
    await expect(repository.liftLoopSuppression("profile-a", "never tracked")).resolves.toBe(0);
    await repository.insertLoopSuppression("profile-a", { subject: "Sleep before midnight" });
    await repository.insertLoopSuppression("profile-b", { subject: "Sleep before midnight" });
    await expect(repository.liftLoopSuppression("profile-a", "  SLEEP   BEFORE MIDNIGHT ")).resolves.toBe(1);
    expect(calls.find((call) => call.operation === "update" && call.table === "loop_suppressions")?.params).toMatchObject({ lifted_at: expect.any(String) });
    expect(calls).toContainEqual({ operation: "eq", table: "loop_suppressions", field: "subject", value: "sleep before midnight" });
    expect(calls).toContainEqual({ operation: "is", table: "loop_suppressions", field: "lifted_at", value: null });
    await expect(repository.listActiveSuppressions("profile-a")).resolves.toHaveLength(0);
    await expect(repository.listActiveSuppressions("profile-b")).resolves.toHaveLength(1);
    await repository.insertLoopSuppression("profile-a", { subject: "Sleep before midnight", reason: "Asked again" });
    await expect(repository.insertLoopSuppression("profile-zzz" as never, { subject: "anything at all" })).rejects.toThrow(/profile scope/i);
    await expect(repository.liftLoopSuppression("profile-zzz" as never, "anything at all")).rejects.toThrow(/profile scope/i);
  });

  it("lists active suppressions newest first scoped to the profile", async () => {
    const { database, rows } = fakeAccountabilityDatabase();
    rows.loop_suppressions.push(
      { id: "sup-old", profile_id: "profile-a", subject: "older topic", reason: "r", created_at: "2026-08-20T10:00:00.000Z", lifted_at: null },
      { id: "sup-new", profile_id: "profile-a", subject: "newer topic", reason: "r", created_at: "2026-08-22T10:00:00.000Z", lifted_at: null },
      { id: "sup-lifted", profile_id: "profile-a", subject: "lifted topic", reason: "r", created_at: "2026-08-21T10:00:00.000Z", lifted_at: "2026-08-21T11:00:00.000Z" },
      { id: "sup-other", profile_id: "profile-b", subject: "other profile topic", reason: "r", created_at: "2026-08-22T11:00:00.000Z", lifted_at: null },
    );
    const repository = createAccountabilityRepository(database as never);
    const subjects = (await repository.listActiveSuppressions("profile-a")).map((row) => row.subject);
    expect(subjects).toEqual(["newer topic", "older topic"]);
    await expect(repository.listActiveSuppressions("profile-zzz" as never)).rejects.toThrow(/profile scope/i);
  });
});
