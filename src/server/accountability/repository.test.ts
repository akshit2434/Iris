import { describe, expect, it } from "vitest";
import { createAccountabilityRepository, StaleOpenLoopRevisionError } from "@/server/accountability/repository";

function fakeAccountabilityDatabase() {
  const calls: Array<{ operation: string; table?: string; field?: string; value?: unknown; params?: unknown }> = [];
  const insertedAt = "2026-08-22T12:00:00.000Z";
  const rows: Record<string, Record<string, unknown>[]> = {
    open_loops: [
      { id: "loop-a", profile_id: "profile-a", title: "Renew passport", details: null, kind: "commitment", status: "open", due_at: "2026-09-01T09:00:00.000Z", cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-20T10:00:00.000Z", updated_at: "2026-08-20T10:00:00.000Z", closed_at: null },
      { id: "loop-done", profile_id: "profile-a", title: "File taxes", details: null, kind: "commitment", status: "done", due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-19T10:00:00.000Z", updated_at: "2026-08-21T10:00:00.000Z", closed_at: "2026-08-21T10:00:00.000Z" },
      { id: "loop-b", profile_id: "profile-b", title: "Book dentist", details: null, kind: "idea", status: "open", due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, created_at: "2026-08-18T10:00:00.000Z", updated_at: "2026-08-18T10:00:00.000Z", closed_at: null },
    ],
    scheduled_checks: [
      { id: "check-due-late", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T10:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-due-early", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T08:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-future", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-23T09:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-other-loop", profile_id: "profile-a", loop_id: "loop-done", due_at: "2026-08-22T06:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-cancelled", profile_id: "profile-a", loop_id: "loop-a", due_at: "2026-08-22T07:00:00.000Z", status: "cancelled", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: "2026-08-21T15:00:00.000Z", cancel_reason: "superseded", created_at: "2026-08-21T10:00:00.000Z" },
      { id: "check-b", profile_id: "profile-b", loop_id: "loop-b", due_at: "2026-08-22T05:00:00.000Z", status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, created_at: "2026-08-21T10:00:00.000Z" },
    ],
    loop_events: [],
  };
  const defaults: Record<string, Record<string, unknown>> = {
    open_loops: { status: "open", details: null, due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, closed_at: null },
    loop_events: { detail: null, actor: "agent", source_thread_id: null, source_message_id: null, agent_run_id: null, metadata: {} },
    scheduled_checks: { status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null },
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
});
