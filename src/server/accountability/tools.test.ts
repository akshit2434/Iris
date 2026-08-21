import { describe, expect, it, vi } from "vitest";
import { createAgentContext, type AgentContext } from "@/server/agent/context";
import {
  closeLoop,
  createAccountabilityTools,
  createLoop,
  listLoops,
  scheduleCheck,
  updateLoop,
} from "@/server/accountability/tools";
import type { AccountabilityRepository, LoopEventActor, OpenLoopRow } from "@/server/accountability/repository";

const ids = {
  thread: "00000000-0000-4000-8000-000000000001",
  message: "00000000-0000-4000-8000-000000000002",
  run: "00000000-0000-4000-8000-000000000003",
};
const LOOP_ID = "00000000-0000-4000-8000-000000000010";
const DUE_AT = "2026-09-01T09:00:00.000Z";
const NEW_DUE_AT = "2026-09-05T09:00:00.000Z";

const context: AgentContext = createAgentContext({
  profileId: "profile-a",
  profileLabel: "Profile A",
  threadId: ids.thread,
  threadTitle: "Tools test",
  currentUserMessageId: ids.message,
  agentRunId: ids.run,
  now: new Date("2026-08-22T12:00:00.000Z"),
});

function makeLoop(overrides: Partial<OpenLoopRow> = {}): OpenLoopRow {
  return {
    id: LOOP_ID,
    profileId: "profile-a",
    title: "Renew passport",
    details: null,
    kind: "commitment",
    status: "open",
    dueAt: DUE_AT,
    cadence: null,
    originThreadId: null,
    originMessageId: null,
    createdAt: "2026-08-20T10:00:00.000Z",
    updatedAt: "2026-08-20T10:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

const WRITE_METHODS = ["insertOpenLoop", "updateOpenLoopStatus", "insertLoopEvent", "insertScheduledCheck", "cancelPendingChecksForLoop"] as const;

function expectNoWrites(repo: AccountabilityRepository) {
  for (const method of WRITE_METHODS) expect(repo[method]).not.toHaveBeenCalled();
}

function fakeRepository(overrides: Partial<AccountabilityRepository> = {}): AccountabilityRepository {
  return {
    listOpenLoops: vi.fn(async () => [makeLoop()]),
    getOpenLoop: vi.fn(async () => makeLoop()),
    insertOpenLoop: vi.fn(async (input) => makeLoop({ id: "generated-loop", dueAt: input.dueAt ?? null, cadence: input.cadence ?? null })),
    updateOpenLoopStatus: vi.fn(async (_profileId, _loopId, _expectedUpdatedAt, patch) => makeLoop({ status: patch.event === "completed" ? "done" : patch.event === "paused" ? "paused" : "open" })),
    insertLoopEvent: vi.fn(async (_profileId, input) => ({ id: "generated-event", profileId: "profile-a" as const, loopId: input.loopId, kind: input.kind, detail: input.detail ?? null, actor: (input.actor ?? "agent") as LoopEventActor, sourceThreadId: input.sourceThreadId ?? null, sourceMessageId: input.sourceMessageId ?? null, agentRunId: input.agentRunId ?? null, metadata: input.metadata ?? {}, createdAt: "2026-08-22T12:00:00.000Z" })),
    listDueChecks: vi.fn(async () => []),
    insertScheduledCheck: vi.fn(async (_profileId, input) => ({ id: "generated-check", profileId: "profile-a" as const, loopId: input.loopId, dueAt: input.dueAt, status: "pending" as const, attemptCount: 0, escalationTier: 0, deliveryId: null, deliveredAt: null, cancelledAt: null, cancelReason: null, createdAt: "2026-08-22T12:00:00.000Z" })),
    cancelPendingChecksForLoop: vi.fn(async () => 2),
    ...overrides,
  };
}

describe("accountability tools", () => {
  it("exposes exactly five tools in fixed order", () => {
    const tools = createAccountabilityTools(fakeRepository());
    expect(tools.map((tool) => tool.name)).toEqual(["loop_list", "loop_create", "loop_update", "loop_close", "schedule_check"]);
  });

  it("gates unconfirmed creations behind clarification without writing", async () => {
    const repo = fakeRepository();
    const result = await createLoop(context, { title: "Renew passport", kind: "commitment", dueAt: DUE_AT, confirm: false }, repo);
    expect(result).toMatchObject({ kind: "loop_create", status: "needs_confirmation" });
    if (result.status !== "needs_confirmation") throw new Error("expected needs_confirmation");
    for (const theme of [/why/i, /capacity/i, /timing/i, /conflict/i]) expect(result.message).toMatch(theme);
    expectNoWrites(repo);
  });

  it("creates a confirmed commitment with provenance and an initial check at its due time", async () => {
    const repo = fakeRepository();
    const result = await createLoop(context, { title: "Renew passport", details: "Expires in November.", kind: "commitment", dueAt: DUE_AT, confirm: true }, repo);
    expect(result).toEqual({ kind: "loop_create", status: "created", loopId: "generated-loop", dueAt: DUE_AT });
    expect(repo.insertOpenLoop).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "profile-a",
      title: "Renew passport",
      details: "Expires in November.",
      kind: "commitment",
      dueAt: DUE_AT,
    }));
    expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({
      loopId: "generated-loop",
      kind: "created",
      actor: "agent",
      sourceThreadId: ids.thread,
      sourceMessageId: ids.message,
      agentRunId: ids.run,
    }));
    expect(repo.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: "generated-loop", dueAt: DUE_AT });
  });

  it("rejects a confirmed routine without cadence before any write", async () => {
    const repo = fakeRepository();
    const result = await createLoop(context, { title: "Water the plants", kind: "routine", confirm: true }, repo);
    expect(result).toMatchObject({ kind: "loop_create", status: "error" });
    if (result.status !== "error") throw new Error("expected error");
    expect(result.message).toMatch(/cadence/i);
    expectNoWrites(repo);
  });

  it("lists open loops as compact summaries", async () => {
    const repo = fakeRepository();
    const result = await listLoops(context, {}, repo);
    expect(result).toEqual({
      kind: "loop_list",
      loops: [{ id: LOOP_ID, title: "Renew passport", kind: "commitment", status: "open", dueAt: DUE_AT, updatedAt: "2026-08-20T10:00:00.000Z" }],
    });
    expect(repo.listOpenLoops).toHaveBeenCalledWith("profile-a");
  });

  it("closes a completed loop with its expected revision and cancels pending checks", async () => {
    const repo = fakeRepository({ cancelPendingChecksForLoop: vi.fn(async () => 3) });
    const result = await closeLoop(context, { loopId: LOOP_ID }, repo);
    expect(result).toEqual({ kind: "loop_close", status: "closed", loopId: LOOP_ID, cancelledChecks: 3 });
    expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: "completed" });
    expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: LOOP_ID, kind: "completed", actor: "agent", sourceMessageId: ids.message }));
    expect(repo.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", LOOP_ID, expect.any(String));
    const [statusOrder] = vi.mocked(repo.updateOpenLoopStatus).mock.invocationCallOrder;
    const [cancelOrder] = vi.mocked(repo.cancelPendingChecksForLoop).mock.invocationCallOrder;
    const [eventOrder] = vi.mocked(repo.insertLoopEvent).mock.invocationCallOrder;
    expect(statusOrder).toBeLessThan(cancelOrder);
    expect(cancelOrder).toBeLessThan(eventOrder);
  });

  it("closes loops through every explicit outcome as its own ledger event", async () => {
    for (const outcome of ["completed", "cancelled", "dropped"] as const) {
      const repo = fakeRepository({ cancelPendingChecksForLoop: vi.fn(async () => 1) });
      const result = await closeLoop(context, { loopId: LOOP_ID, outcome }, repo);
      expect(result).toEqual({ kind: "loop_close", status: "closed", loopId: LOOP_ID, cancelledChecks: 1 });
      expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: outcome });
      expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: LOOP_ID, kind: outcome }));
    }
  });

  it("refuses to close a terminal loop without touching checks", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => makeLoop({ status: "done", closedAt: "2026-08-21T10:00:00.000Z" })) });
    const result = await closeLoop(context, { loopId: LOOP_ID }, repo);
    expect(result).toMatchObject({ kind: "loop_close", status: "error" });
    if (result.status !== "error") throw new Error("expected error");
    expect(result.message).toMatch(/illegal|terminal/i);
    expect(repo.updateOpenLoopStatus).not.toHaveBeenCalled();
    expect(repo.cancelPendingChecksForLoop).not.toHaveBeenCalled();
  });

  it("schedules a pending check for an open loop and returns its identity", async () => {
    const repo = fakeRepository();
    const result = await scheduleCheck(context, { loopId: LOOP_ID, dueAt: NEW_DUE_AT }, repo);
    expect(result).toEqual({ kind: "schedule_check", status: "scheduled", checkId: "generated-check", dueAt: NEW_DUE_AT });
    expect(repo.getOpenLoop).toHaveBeenCalledWith("profile-a", LOOP_ID);
    expect(repo.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: LOOP_ID, dueAt: NEW_DUE_AT });
  });

  it("rejects scheduled checks against closed loops", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => makeLoop({ status: "cancelled", closedAt: "2026-08-21T10:00:00.000Z" })) });
    const result = await scheduleCheck(context, { loopId: LOOP_ID, dueAt: NEW_DUE_AT }, repo);
    expect(result).toMatchObject({ kind: "schedule_check", status: "error" });
    expect(repo.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("rejects scheduled checks against paused loops", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => makeLoop({ status: "paused" })) });
    const result = await scheduleCheck(context, { loopId: LOOP_ID, dueAt: NEW_DUE_AT }, repo);
    expect(result).toMatchObject({ kind: "schedule_check", status: "error" });
    if (result.status !== "error") throw new Error("expected error");
    expect(result.message).toMatch(/paused/i);
    expect(repo.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("rejects updates on terminal loops without writing", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => makeLoop({ status: "done", closedAt: "2026-08-21T10:00:00.000Z" })) });
    for (const action of ["reschedule", "pause", "resume"] as const) {
      const result = await updateLoop(context, { loopId: LOOP_ID, action, ...(action === "reschedule" ? { dueAt: NEW_DUE_AT } : {}) }, repo);
      expect(result).toMatchObject({ kind: "loop_update", status: "error" });
      if (result.status === "error") expect(result.message).toMatch(/illegal|terminal|not allowed/i);
    }
    expectNoWrites(repo);
  });

  it("rejects resuming a loop that is already open", async () => {
    const repo = fakeRepository();
    const result = await updateLoop(context, { loopId: LOOP_ID, action: "resume" }, repo);
    expect(result).toMatchObject({ kind: "loop_update", status: "error" });
    if (result.status === "error") expect(result.message).toMatch(/resumed.*not allowed|not allowed/i);
    expectNoWrites(repo);
  });

  it("reschedules by moving pending checks to the new time with a rescheduled event", async () => {
    const repo = fakeRepository();
    const result = await updateLoop(context, { loopId: LOOP_ID, action: "reschedule", dueAt: NEW_DUE_AT }, repo);
    expect(result).toEqual({ kind: "loop_update", status: "updated", loopId: LOOP_ID });
    expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: "rescheduled", dueAt: NEW_DUE_AT });
    expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: LOOP_ID, kind: "rescheduled" }));
    expect(repo.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", LOOP_ID, expect.any(String));
    expect(repo.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: LOOP_ID, dueAt: NEW_DUE_AT });
  });

  it("keeps a rescheduled due time when the loop later resumes", async () => {
    let current = makeLoop({ status: "paused" });
    const repo = fakeRepository({
      getOpenLoop: vi.fn(async () => current),
      updateOpenLoopStatus: vi.fn(async (_profileId, _loopId, _expectedUpdatedAt, patch) => {
        current = { ...current, status: patch.event === "paused" ? ("paused" as const) : patch.event === "resumed" ? ("open" as const) : current.status, dueAt: patch.dueAt ?? current.dueAt };
        return current;
      }),
    });
    await updateLoop(context, { loopId: LOOP_ID, action: "reschedule", dueAt: NEW_DUE_AT }, repo);
    expect(repo.insertScheduledCheck).not.toHaveBeenCalled();
    await updateLoop(context, { loopId: LOOP_ID, action: "resume" }, repo);
    expect(repo.insertScheduledCheck).toHaveBeenCalledTimes(1);
    expect(repo.insertScheduledCheck).toHaveBeenLastCalledWith("profile-a", { loopId: LOOP_ID, dueAt: NEW_DUE_AT });
  });

  it("leaves zero live checks when rescheduling a paused loop", async () => {
    const repo = fakeRepository({
      getOpenLoop: vi.fn(async () => makeLoop({ status: "paused", dueAt: DUE_AT })),
      updateOpenLoopStatus: vi.fn(async (_profileId, _loopId, _expectedUpdatedAt, patch) => makeLoop({ status: "paused", dueAt: patch.dueAt ?? DUE_AT })),
    });
    const result = await updateLoop(context, { loopId: LOOP_ID, action: "reschedule", dueAt: NEW_DUE_AT }, repo);
    expect(result).toEqual({ kind: "loop_update", status: "updated", loopId: LOOP_ID });
    expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: "rescheduled", dueAt: NEW_DUE_AT });
    expect(repo.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", LOOP_ID, expect.any(String));
    expect(repo.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("pauses by cancelling pending checks without scheduling new ones", async () => {
    const repo = fakeRepository();
    const result = await updateLoop(context, { loopId: LOOP_ID, action: "pause" }, repo);
    expect(result).toEqual({ kind: "loop_update", status: "updated", loopId: LOOP_ID });
    expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: "paused" });
    expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: LOOP_ID, kind: "paused" }));
    expect(repo.cancelPendingChecksForLoop).toHaveBeenCalled();
    expect(repo.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("resumes with exactly one pending check, cancelling leftovers before inserting", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => makeLoop({ status: "paused", dueAt: NEW_DUE_AT })) });
    const result = await updateLoop(context, { loopId: LOOP_ID, action: "resume" }, repo);
    expect(result).toEqual({ kind: "loop_update", status: "updated", loopId: LOOP_ID });
    expect(repo.updateOpenLoopStatus).toHaveBeenCalledWith("profile-a", LOOP_ID, "2026-08-20T10:00:00.000Z", { event: "resumed" });
    expect(repo.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: LOOP_ID, kind: "resumed" }));
    expect(repo.insertScheduledCheck).toHaveBeenCalledTimes(1);
    expect(repo.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: LOOP_ID, dueAt: NEW_DUE_AT });
    const [cancelOrder] = vi.mocked(repo.cancelPendingChecksForLoop).mock.invocationCallOrder;
    const [insertOrder] = vi.mocked(repo.insertScheduledCheck).mock.invocationCallOrder;
    expect(cancelOrder).toBeLessThan(insertOrder);
  });

  it("reports repository failures as error outputs instead of throwing", async () => {
    const repo = fakeRepository({
      getOpenLoop: vi.fn(async () => makeLoop()),
      updateOpenLoopStatus: vi.fn(async () => {
        throw new Error("Open loop was modified concurrently; reload it and retry.");
      }),
    });
    await expect(closeLoop(context, { loopId: LOOP_ID }, repo)).resolves.toMatchObject({ kind: "loop_close", status: "error", message: expect.stringMatching(/concurrently/i) });
    await expect(updateLoop(context, { loopId: LOOP_ID, action: "pause" }, repo)).resolves.toMatchObject({ kind: "loop_update", status: "error", message: expect.stringMatching(/concurrently/i) });
  });

  it("answers missing loops with errors before writing", async () => {
    const repo = fakeRepository({ getOpenLoop: vi.fn(async () => null) });
    await expect(closeLoop(context, { loopId: LOOP_ID }, repo)).resolves.toMatchObject({ kind: "loop_close", status: "error", message: expect.stringMatching(/not found/i) });
    await expect(scheduleCheck(context, { loopId: LOOP_ID, dueAt: NEW_DUE_AT }, repo)).resolves.toMatchObject({ kind: "schedule_check", status: "error" });
    await expect(updateLoop(context, { loopId: LOOP_ID, action: "resume" }, repo)).resolves.toMatchObject({ kind: "loop_update", status: "error" });
    expectNoWrites(repo);
  });
});
