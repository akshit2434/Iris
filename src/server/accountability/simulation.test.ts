import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentContext, type AgentContext } from "@/server/agent/context";
import { composeCheckinMessage, type CheckinKind } from "@/server/accountability/composer";
import {
  createAccountabilityRepository,
  type AccountabilityRepository,
  type MarkCheckDeliveredInput,
} from "@/server/accountability/repository";
import { runAccountabilitySweep, type SweepReport } from "@/server/accountability/sweeper";
import type {
  CommitmentSearchClient,
  CompletionClassifier,
  ReconciliationCandidate,
} from "@/server/accountability/reconciler";
import { closeLoop, createLoop, scheduleCheck, suppressLoop, updateLoop } from "@/server/accountability/tools";
import { loadOpenLoopsForProfile } from "@/server/accountability/context-loader";

vi.mock("server-only", () => ({}));

const MONDAY = 17;
const SWEEP_TIME = "09:30";
const THREAD_A = "00000000-0000-4000-8000-0000000000a1";
const THREAD_B = "00000000-0000-4000-8000-0000000000b1";
const USER_MESSAGE_ID = "00000000-0000-4000-8000-0000000000c1";
const AGENT_RUN_ID = "00000000-0000-4000-8000-0000000000d1";
const PROFILES = ["profile-a", "profile-b"] as const;

function at(dayOffsetFromMonday: number, time: string): string {
  const day = MONDAY + dayOffsetFromMonday;
  return `2026-08-${String(day).padStart(2, "0")}T${time}:00.000Z`;
}

type Tables = {
  open_loops: Record<string, unknown>[];
  scheduled_checks: Record<string, unknown>[];
  loop_events: Record<string, unknown>[];
  checkin_deliveries: Record<string, unknown>[];
  loop_suppressions: Record<string, unknown>[];
};

function createAccountabilityDatabase() {
  const rows: Tables = {
    open_loops: [],
    scheduled_checks: [],
    loop_events: [],
    checkin_deliveries: [],
    loop_suppressions: [],
  };
  const defaults: Record<string, Record<string, unknown>> = {
    open_loops: { status: "open", details: null, due_at: null, cadence: null, origin_thread_id: null, origin_message_id: null, closed_at: null },
    loop_events: { detail: null, actor: "agent", source_thread_id: null, source_message_id: null, agent_run_id: null, metadata: {} },
    scheduled_checks: { status: "pending", attempt_count: 0, escalation_tier: 0, delivery_id: null, delivered_at: null, cancelled_at: null, cancel_reason: null, claimed_at: null },
    checkin_deliveries: { message_id: null, summary: null, status: "pending", delivered_at: null, answered_at: null },
    loop_suppressions: { lifted_at: null },
  };
  let generated = 0;
  const idPrefix: Record<string, string> = {
    open_loops: "1",
    scheduled_checks: "2",
    loop_events: "3",
    checkin_deliveries: "4",
    loop_suppressions: "5",
  };
  const at = (row: Record<string, unknown>, field: string) => row[field];
  const chain = (table: string) => {
    const builder: Record<string, (...args: unknown[]) => unknown> = {};
    let filtered = [...rows[table as keyof Tables]];
    let pendingPatch: Record<string, unknown> | null = null;
    const applyPendingPatch = () => {
      if (!pendingPatch) return;
      const targets = new Set(filtered);
      const patchedRows: Record<string, unknown>[] = [];
      rows[table as keyof Tables] = rows[table as keyof Tables].map((row) => {
        if (!targets.has(row)) return row;
        const patched = { ...row, ...pendingPatch };
        patchedRows.push(patched);
        return patched;
      });
      filtered = patchedRows;
      pendingPatch = null;
    };
    builder.select = () => builder;
    builder.eq = (field: unknown, value: unknown) => { filtered = filtered.filter((row) => at(row, String(field)) === value); return builder; };
    builder.in = (field: unknown, values: unknown) => { filtered = filtered.filter((row) => (values as unknown[]).includes(at(row, String(field)))); return builder; };
    builder.lte = (field: unknown, value: unknown) => { filtered = filtered.filter((row) => String(at(row, String(field))) <= String(value)); return builder; };
    builder.is = (field: unknown, value: unknown) => { filtered = filtered.filter((row) => at(row, String(field)) === value); return builder; };
    builder.lt = (field: unknown, value: unknown) => { filtered = filtered.filter((row) => String(at(row, String(field))) < String(value)); return builder; };
    builder.or = (expr: unknown) => {
      const clauses = String(expr).split(",").map((clause) => /^(.+)\.(is|lt)\.(.+)$/.exec(clause));
      filtered = filtered.filter((row) => clauses.some((match) => {
        if (!match) return false;
        const [, field, op, raw] = match;
        const cell = at(row, field);
        if (op === "is") return raw === "null" && (cell === null || cell === undefined);
        return String(cell) < raw;
      }));
      return builder;
    };
    builder.order = (field: unknown, options: unknown) => {
      const direction = (options as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1;
      filtered = [...filtered].sort((left, right) => String(at(left, String(field))).localeCompare(String(at(right, String(field)))) * direction);
      return builder;
    };
    builder.limit = (count: unknown) => { filtered = filtered.slice(0, Number(count)); return builder; };
    builder.maybeSingle = () => Promise.resolve({ data: filtered[0] ?? null, error: null });
    builder.single = () => Promise.resolve(filtered.length > 0 ? { data: filtered[0], error: null } : { data: null, error: { message: "no rows returned" } });
    builder.insert = (value: unknown) => {
      generated += 1;
      const record: Record<string, unknown> = {
        id: `00000000-0000-4000-800${idPrefix[table]}-${String(generated).padStart(11, "0")}`,
        created_at: "2026-08-01T00:00:00.000Z",
        ...(defaults[table] ?? {}),
        ...(value as Record<string, unknown>),
      };
      if (table === "open_loops") record.updated_at = "2026-08-01T00:00:00.000Z";
      rows[table as keyof Tables].push(record);
      filtered = [record];
      return builder;
    };
    builder.update = (value: unknown) => { pendingPatch = value as Record<string, unknown>; return builder; };
    builder.then = (...args: unknown[]) => {
      applyPendingPatch();
      const resolve = args[0] as ((value: unknown) => unknown) | undefined;
      const promise = Promise.resolve({ data: filtered, error: null });
      return resolve ? promise.then(resolve) : promise;
    };
    return builder;
  };
  return {
    client: {
      from(table: string) { return chain(table); },
      async rpc(name: string, params: Record<string, unknown>) {
        if (name !== "claim_accountability_checks") return { data: [], error: null };
        const matched = [...rows.scheduled_checks]
          .filter((row) =>
            at(row, "profile_id") === params.p_profile_id &&
            at(row, "status") === "pending" &&
            String(at(row, "due_at")) <= String(params.p_now) &&
            (at(row, "claimed_at") === null || String(at(row, "claimed_at")) < String(params.p_stale_before)))
          .sort((left, right) => String(at(left, "due_at")).localeCompare(String(at(right, "due_at"))) || String(at(left, "id")).localeCompare(String(at(right, "id"))))
          .slice(0, Math.max(Number(params.p_limit ?? 8), 1));
        const targets = new Set(matched);
        const claimed: Record<string, unknown>[] = [];
        rows.scheduled_checks = rows.scheduled_checks.map((row) => {
          if (!targets.has(row)) return row;
          const updated = { ...row, claimed_at: params.p_now };
          claimed.push(updated);
          return updated;
        });
        return { data: claimed.sort((left, right) => String(at(left, "due_at")).localeCompare(String(at(right, "due_at")))), error: null };
      },
    },
    rows,
  };
}

type DeliveryLogEntry = { checkId: string; input: MarkCheckDeliveredInput };

function createWorld() {
  const db = createAccountabilityDatabase();
  const raw = createAccountabilityRepository(db.client as never);
  const deliveryLog: DeliveryLogEntry[] = [];
  const writtenMessages: Array<{ id: string; profileId: string; content: string }> = [];
  const composedRequests: Array<{ kind: CheckinKind; titles: string[] }> = [];
  const reports: Array<{ now: string; report: SweepReport }> = [];
  const threads: Record<(typeof PROFILES)[number], string | null> = { "profile-a": THREAD_A, "profile-b": THREAD_B };
  let sequence = 0;
  const repository: AccountabilityRepository = {
    ...raw,
    async markCheckDelivered(profileId, checkId, input) {
      const delivered = await raw.markCheckDelivered(profileId, checkId, input);
      deliveryLog.push({ checkId, input });
      return delivered;
    },
  };
  const composer = async (request: { kind: CheckinKind; loops: Array<{ title: string }> }) => {
    composedRequests.push({ kind: request.kind, titles: request.loops.map((loop) => loop.title) });
    return `[${request.kind}] ${request.loops.map((loop) => loop.title).join(", ")}`;
  };
  const messageWriter = async (input: { profileId: string; content: string }) => {
    sequence += 1;
    const id = `msg-${String(sequence).padStart(3, "0")}`;
    writtenMessages.push({ id, profileId: input.profileId, content: input.content });
    return { id };
  };
  const threadLister = async (profileId: (typeof PROFILES)[number]) => (threads[profileId] ? [{ id: threads[profileId] }] : []);
  const searchCalls: Array<{ profileId: string; query: string; from: string | null }> = [];
  const classifyCalls: Array<{ title: string; candidates: ReconciliationCandidate[] }> = [];
  let historyCandidates: ReconciliationCandidate[] = [];
  let classification: { completed: boolean; confidence: number; supportingIndex?: number | null } = { completed: false, confidence: 0 };
  const retrieval: CommitmentSearchClient = async (input) => {
    searchCalls.push({ profileId: input.profileId, query: input.query, from: input.from ?? null });
    return historyCandidates;
  };
  const classifier: CompletionClassifier = async (input) => {
    classifyCalls.push(input);
    return classification;
  };
  const sweep = async (options: { profiles?: Array<(typeof PROFILES)[number]>; limitPerProfile?: number } = {}) => {
    const report = await runAccountabilitySweep({
      now: currentNow(),
      profiles: options.profiles ? [...options.profiles] : undefined,
      limitPerProfile: options.limitPerProfile,
      repository,
      composer,
      messageWriter,
      threadLister: threadLister as never,
      retrieval,
      classifier,
    });
    reports.push({ now: currentNow(), report });
    assertInvariants();
    return report;
  };
  let now = at(0, "00:00");
  function currentNow(): string {
    return now;
  }
  function advanceTo(iso: string) {
    now = iso;
    vi.setSystemTime(new Date(iso));
  }
  function agentContextFor(profileId: (typeof PROFILES)[number]): AgentContext {
    return createAgentContext({
      profileId,
      profileLabel: profileId === "profile-a" ? "Profile A" : "Profile B",
      threadId: threads[profileId] ?? THREAD_A,
      threadTitle: "Simulation",
      currentUserMessageId: USER_MESSAGE_ID,
      agentRunId: AGENT_RUN_ID,
      now: new Date(now),
    });
  }
  const agent = {
    trackCommitment: async (input: { title: string; dueAt: string }, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await createLoop(agentContextFor(profileId), { title: input.title, kind: "commitment", dueAt: input.dueAt, confirm: true }, repository);
      expect(result).toMatchObject({ kind: "loop_create", status: "created" });
      if (result.status !== "created") throw new Error("commitment creation failed");
      return result.loopId;
    },
    trackRoutine: async (input: { title: string }, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await createLoop(agentContextFor(profileId), { title: input.title, kind: "routine", cadence: { kind: "daily" }, confirm: true }, repository);
      expect(result).toMatchObject({ kind: "loop_create", status: "created" });
      if (result.status !== "created") throw new Error("routine creation failed");
      return result.loopId;
    },
    complete: async (loopId: string, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await closeLoop(agentContextFor(profileId), { loopId }, repository);
      expect(result).toMatchObject({ kind: "loop_close", status: "closed" });
      if (result.status !== "closed") throw new Error("close failed");
      return result.cancelledChecks;
    },
    scheduleFollowUp: async (loopId: string, dueAt: string, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await scheduleCheck(agentContextFor(profileId), { loopId, dueAt }, repository);
      expect(result).toMatchObject({ kind: "schedule_check", status: "scheduled" });
      if (result.status !== "scheduled") throw new Error("schedule failed");
      return result.checkId;
    },
    pause: async (loopId: string, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await updateLoop(agentContextFor(profileId), { loopId, action: "pause" }, repository);
      expect(result).toMatchObject({ kind: "loop_update", status: "updated" });
    },
    resume: async (loopId: string, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await updateLoop(agentContextFor(profileId), { loopId, action: "resume" }, repository);
      expect(result).toMatchObject({ kind: "loop_update", status: "updated" });
    },
    suppress: async (input: { subject: string; lift?: boolean }, profileId: (typeof PROFILES)[number] = "profile-a") => {
      const result = await suppressLoop(agentContextFor(profileId), { subject: input.subject, confirm: true, ...(input.lift ? { lift: true } : {}) }, repository);
      expect(result).toMatchObject({ kind: "loop_suppress", status: input.lift ? "lifted" : "suppressed" });
      if (result.status === "error") throw new Error("suppress failed");
      return result;
    },
  };
  const contextLoopTitles = async (profileId: (typeof PROFILES)[number] = "profile-a") =>
    (await loadOpenLoopsForProfile(repository, profileId)).map((entry) => entry.title);
  const loops = () => db.rows.open_loops;
  const checks = () => db.rows.scheduled_checks;
  const events = () => db.rows.loop_events;
  const deliveries = () => db.rows.checkin_deliveries;
  const checksForLoop = (loopId: string) => checks().filter((check) => check.loop_id === loopId);
  const nudgedCount = (loopId: string) => events().filter((event) => event.loop_id === loopId && event.kind === "nudged").length;
  const loopByTitle = (title: string) => loops().find((loop) => loop.title === title);
  function assertInvariants() {
    const terminalStatuses = ["done", "cancelled", "dropped"];
    for (const loop of loops()) {
      if (!terminalStatuses.includes(String(loop.status))) continue;
      const stillPending = checksForLoop(String(loop.id)).filter((check) => check.status === "pending");
      expect(stillPending).toHaveLength(0);
    }
    const perCheckDeliveries = new Map<string, number>();
    for (const entry of deliveryLog) perCheckDeliveries.set(entry.checkId, (perCheckDeliveries.get(entry.checkId) ?? 0) + 1);
    for (const check of checks()) {
      const timesDelivered = perCheckDeliveries.get(String(check.id)) ?? 0;
      if (check.status === "delivered") {
        expect(timesDelivered).toBe(1);
        expect(check.delivery_id).not.toBeNull();
        expect(check.delivered_at).not.toBeNull();
      } else {
        expect(timesDelivered).toBe(0);
      }
      if (timesDelivered > 0) expect(check.status).toBe("delivered");
    }
    const messageIds = new Set(writtenMessages.map((message) => message.id));
    for (const delivery of deliveries()) {
      if (delivery.message_id !== null) expect(messageIds.has(String(delivery.message_id))).toBe(true);
    }
  }
  return {
    advanceTo,
    agent,
    at,
    checks,
    checksForLoop,
    composerRequests: composedRequests,
    contextLoopTitles,
    deliveries,
    deliveryLog,
    events,
    loops,
    loopByTitle,
    messages: writtenMessages,
    nudgedCount,
    reconcile: {
      searchCalls,
      classifyCalls,
      setHistory(candidates: ReconciliationCandidate[]) {
        historyCandidates = candidates;
      },
      setClassification(next: { completed: boolean; confidence: number; supportingIndex?: number | null }) {
        classification = next;
      },
    },
    reports,
    repository,
    rows: db.rows,
    sweep,
    threads,
    get now() { return now; },
  };
}

type World = ReturnType<typeof createWorld>;

function sweepProfileA(world: World) {
  return world.sweep({ profiles: ["profile-a"] });
}

async function sweepDaily(world: World, fromDay: number, throughDay: number, time = SWEEP_TIME) {
  const dailyReports = [];
  for (let day = fromDay; day <= throughDay; day += 1) {
    world.advanceTo(at(day, time));
    dailyReports.push(await world.sweep());
  }
  return dailyReports;
}

describe("accountability multi-week simulation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("scenario 1: a monday commitment is delivered once, friday morning, as a single tier-0 message", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const assignmentId = await world.agent.trackCommitment({ title: "Submit OS assignment", dueAt: at(4, "09:00") });

    for (let day = 0; day <= 3; day += 1) {
      world.advanceTo(at(day, SWEEP_TIME));
      const report = await sweepProfileA(world);
      expect(report.profiles[0]).toMatchObject({ selected: 0, delivered: 0 });
    }

    world.advanceTo(at(4, SWEEP_TIME));
    const friday = await sweepProfileA(world);
    expect(friday.profiles[0]).toEqual({ profileId: "profile-a", selected: 1, delivered: 1, mergedBatches: 1, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 });
    expect(world.composerRequests).toHaveLength(0);
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).toContain("Submit OS assignment");

    const [check] = world.checksForLoop(assignmentId);
    expect(check).toMatchObject({ status: "delivered", attempt_count: 1, escalation_tier: 1, delivered_at: at(4, SWEEP_TIME) });

    world.advanceTo(at(4, "23:00"));
    const repeat = await sweepProfileA(world);
    expect(repeat.profiles[0]).toMatchObject({ selected: 0, delivered: 0 });
    expect(world.messages).toHaveLength(1);
  });

  it("scenario 2: three commitments due the same morning merge into one batched nudge with three nudges", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    await world.agent.trackCommitment({ title: "Renew passport", dueAt: at(2, "08:00") });
    await world.agent.trackCommitment({ title: "Buy groceries", dueAt: at(2, "08:00") });
    await world.agent.trackCommitment({ title: "Pay rent", dueAt: at(2, "08:00") });

    world.advanceTo(at(1, SWEEP_TIME));
    expect((await sweepProfileA(world)).profiles[0]).toMatchObject({ selected: 0 });

    world.advanceTo(at(2, SWEEP_TIME));
    const wednesday = await sweepProfileA(world);
    expect(wednesday.profiles[0]).toMatchObject({ selected: 3, delivered: 3, mergedBatches: 1, failed: 0 });
    expect(world.composerRequests).toEqual([{ kind: "merged_batch", titles: ["Renew passport", "Buy groceries", "Pay rent"] }]);
    expect(world.messages).toHaveLength(1);

    for (const title of ["Renew passport", "Buy groceries", "Pay rent"]) {
      const loopId = String(world.loopByTitle(title)?.id);
      expect(loopId).toBeTruthy();
      expect(world.nudgedCount(loopId)).toBe(1);
      for (const check of world.checksForLoop(loopId)) {
        expect(check).toMatchObject({ status: "delivered", attempt_count: 1, escalation_tier: 1 });
      }
    }
    expect(world.deliveryLog).toHaveLength(3);
    const deliveryIds = new Set(world.deliveryLog.map((entry) => entry.input.deliveryId));
    expect(deliveryIds.size).toBe(1);
  });

  it("scenario 3: a midweek 'done' reply closes the loop and its friday check never delivers", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    await world.agent.trackCommitment({ title: "Submit OS assignment", dueAt: at(4, "09:00") });
    const passportId = await world.agent.trackCommitment({ title: "Renew passport", dueAt: at(4, "09:00") });

    world.advanceTo(at(3, "12:00"));
    const cancelledChecks = await world.agent.complete(passportId);
    expect(cancelledChecks).toBe(1);

    const [passportCheck] = world.checksForLoop(passportId);
    expect(passportCheck).toMatchObject({ status: "cancelled", cancel_reason: expect.stringMatching(/completed/i) });
    expect(passportCheck.delivered_at).toBeNull();

    world.advanceTo(at(4, SWEEP_TIME));
    const friday = await sweepProfileA(world);
    expect(friday.profiles[0]).toMatchObject({ selected: 1, delivered: 1, cancelledStale: 0 });
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).not.toContain("Renew passport");
    expect(world.deliveryLog.map((entry) => entry.checkId)).toEqual([world.checksForLoop(String(world.loopByTitle("Submit OS assignment")?.id))[0].id]);
  });

  it("scenario 4: a daily routine reflects each morning, goes silent while paused, and restarts after resume", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "08:00"));
    const dsaId = await world.agent.trackRoutine({ title: "DSA practice" });
    for (const day of [1, 2, 3, 4]) {
      await world.agent.scheduleFollowUp(dsaId, at(day, "07:00"));
    }

    for (let day = 1; day <= 3; day += 1) {
      world.advanceTo(at(day, "07:30"));
      const morning = await sweepProfileA(world);
      expect(morning.profiles[0]).toMatchObject({ selected: 1, delivered: 1 });
      expect(world.composerRequests.at(-1)).toEqual({ kind: "routine_reflection", titles: ["DSA practice"] });
    }
    const nudgesBeforePause = world.nudgedCount(dsaId);
    expect(nudgesBeforePause).toBe(3);

    world.advanceTo(at(3, "20:00"));
    await world.agent.pause(dsaId);
    expect(world.checksForLoop(dsaId).every((check) => check.status !== "pending")).toBe(true);

    for (const day of [4, 5]) {
      world.advanceTo(at(day, "07:30"));
      const silentMorning = await sweepProfileA(world);
      expect(silentMorning.profiles[0]).toMatchObject({ selected: 0, delivered: 0 });
    }
    expect(world.nudgedCount(dsaId)).toBe(nudgesBeforePause);

    world.advanceTo(at(6, "09:00"));
    await world.agent.resume(dsaId);
    await world.agent.scheduleFollowUp(dsaId, at(7, "07:00"));

    world.advanceTo(at(7, "07:30"));
    const monday = await sweepProfileA(world);
    expect(monday.profiles[0]).toMatchObject({ selected: 1, delivered: 1 });
    expect(world.composerRequests.at(-1)).toEqual({ kind: "routine_reflection", titles: ["DSA practice"] });
    expect(world.nudgedCount(dsaId)).toBe(4);
  });

  it("scenario 5: an ignored check re-nudges with attempt 2 tier 1, then flips to catch-up phrasing past two overdue days", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "08:00"));
    const dentistId = await world.agent.trackCommitment({ title: "Book dentist", dueAt: at(1, "08:00") });

    world.advanceTo(at(1, "08:30"));
    await sweepProfileA(world);
    expect(world.composerRequests).toHaveLength(0);
    const firstAsk = world.messages.at(-1)?.content ?? "";
    expect(firstAsk).toMatch(/Quick check/i);

    world.advanceTo(at(1, "12:00"));
    await world.agent.scheduleFollowUp(dentistId, at(2, "08:00"));

    world.advanceTo(at(2, "08:30"));
    await sweepProfileA(world);
    expect(world.composerRequests).toHaveLength(0);
    const secondAsk = world.messages.at(-1)?.content ?? "";
    expect(secondAsk).toMatch(/Gentle reminder/i);
    expect(secondAsk).not.toBe(firstAsk);

    world.advanceTo(at(2, "12:00"));
    await world.agent.scheduleFollowUp(dentistId, at(4, "08:00"));

    world.advanceTo(at(4, "08:30"));
    await sweepProfileA(world);
    expect(world.composerRequests).toEqual([{ kind: "catch_up", titles: ["Book dentist"] }]);

    expect(world.deliveryLog.map((entry) => entry.input.attemptCount)).toEqual([1, 2, 3]);
    expect(world.deliveryLog.map((entry) => entry.input.escalationTier)).toEqual([1, 2, 3]);
    const attempts = world.checksForLoop(dentistId).filter((check) => check.status === "delivered");
    expect(attempts).toHaveLength(3);
    expect(attempts.every((check) => check.loop_id === dentistId)).toBe(true);
  });

  it("scenario 6: a profile without a thread skips delivery, keeps checks pending, and delivers once a thread appears", async () => {
    const world = createWorld();
    world.threads["profile-b"] = null;
    world.advanceTo(at(0, "10:00"));
    const plantsId = await world.agent.trackCommitment({ title: "Water plants", dueAt: at(1, "09:00") }, "profile-b");

    world.advanceTo(at(1, SWEEP_TIME));
    const tuesday = await world.sweep({ profiles: ["profile-b"] });
    expect(tuesday.profiles[0]).toEqual({ profileId: "profile-b", selected: 1, delivered: 0, mergedBatches: 0, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 1, suppressed: 0, failed: 0 });
    expect(world.messages).toHaveLength(0);
    expect(world.checksForLoop(plantsId)[0]).toMatchObject({ status: "pending", attempt_count: 0 });

    world.advanceTo(at(2, SWEEP_TIME));
    const wednesday = await world.sweep({ profiles: ["profile-b"] });
    expect(wednesday.profiles[0]).toMatchObject({ skippedNoThread: 1, delivered: 0 });
    expect(world.checksForLoop(plantsId)[0]).toMatchObject({ status: "pending" });

    world.threads["profile-b"] = THREAD_B;
    world.advanceTo(at(3, SWEEP_TIME));
    const thursday = await world.sweep({ profiles: ["profile-b"] });
    expect(thursday.profiles[0]).toEqual({ profileId: "profile-b", selected: 1, delivered: 1, mergedBatches: 1, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 });
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).toContain("Water plants");
    expect(world.checksForLoop(plantsId)[0]).toMatchObject({ status: "delivered", attempt_count: 1 });
  });

  it("scenario 7: fourteen simulated days keep zero re-deliveries and zero pending checks on terminal loops", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const assignmentId = await world.agent.trackCommitment({ title: "Submit OS assignment", dueAt: at(4, "09:00") });
    const dentistId = await world.agent.trackCommitment({ title: "Book dentist", dueAt: at(1, "08:00") });
    const dsaId = await world.agent.trackRoutine({ title: "DSA practice" });
    for (const day of [1, 2, 3, 4]) await world.agent.scheduleFollowUp(dsaId, at(day, "07:00"));
    world.threads["profile-b"] = null;
    const plantsId = await world.agent.trackCommitment({ title: "Water plants", dueAt: at(5, "09:00") }, "profile-b");

    for (let day = 0; day <= 13; day += 1) {
      if (day === 1) {
        world.advanceTo(at(day, "12:00"));
        await world.agent.scheduleFollowUp(dentistId, at(2, "08:00"));
      }
      if (day === 2) {
        world.advanceTo(at(day, "12:00"));
        await world.agent.scheduleFollowUp(dentistId, at(9, "08:00"));
      }
      if (day === 3) {
        world.advanceTo(at(day, "07:30"));
        await sweepProfileA(world);
        world.advanceTo(at(day, "20:00"));
        await world.agent.pause(dsaId);
        continue;
      }
      if (day === 4) {
        world.advanceTo(at(day, SWEEP_TIME));
        await world.agent.complete(assignmentId);
        await sweepProfileA(world);
        continue;
      }
      if (day === 6) {
        world.advanceTo(at(day, "09:00"));
        await world.agent.resume(dsaId);
        await world.agent.scheduleFollowUp(dsaId, at(7, "07:00"));
      }
      if (day === 8) {
        const stale = world.loops().find((loop) => loop.id === plantsId);
        stale!.status = "cancelled";
        stale!.closed_at = at(8, "10:00");
        stale!.updated_at = at(8, "10:00");
      }
      world.advanceTo(at(day, SWEEP_TIME));
      await world.sweep();
    }

    const deliveredChecks = world.checks().filter((check) => check.status === "delivered");
    expect(deliveredChecks.length).toBe(world.deliveryLog.length);
    expect(new Set(world.deliveryLog.map((entry) => entry.checkId)).size).toBe(world.deliveryLog.length);
    for (const loop of [assignmentId, dentistId, dsaId, plantsId]) {
      expect(world.checksForLoop(loop).some((check) => check.status === "pending")).toBe(false);
    }
    expect(String(world.loopByTitle("Submit OS assignment")?.status)).toBe("done");
    expect(world.nudgedCount(plantsId)).toBe(0);
  });

  it("scenario 8: 'stop asking about sleep' suppresses the topic, sweeps skip its checks, and lifting resumes them", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "08:00"));
    const sleepId = await world.agent.trackRoutine({ title: "Sleep before midnight" });
    const assignmentId = await world.agent.trackCommitment({ title: "Submit OS assignment", dueAt: at(4, "09:00") });
    for (const day of [1, 2, 3]) await world.agent.scheduleFollowUp(sleepId, at(day, "07:00"));

    world.advanceTo(at(1, "07:30"));
    const firstMorning = await sweepProfileA(world);
    expect(firstMorning.profiles[0]).toMatchObject({ selected: 1, delivered: 1, suppressed: 0 });
    expect(world.composerRequests.at(-1)).toEqual({ kind: "routine_reflection", titles: ["Sleep before midnight"] });

    world.advanceTo(at(1, "12:00"));
    const messageCountBeforeSuppression = world.messages.length;
    const suppression = await world.agent.suppress({ subject: "  SLEEP   Before   Midnight " });
    expect(suppression).toMatchObject({ status: "suppressed", subject: "sleep before midnight" });
    expect(world.rows.loop_suppressions).toHaveLength(1);
    expect(world.rows.loop_suppressions[0]).toMatchObject({ profile_id: "profile-a", subject: "sleep before midnight", lifted_at: null });
    expect(world.events().filter((event) => event.loop_id === sleepId && event.kind === "suppressed")).toHaveLength(1);
    expect(await world.contextLoopTitles()).toEqual(["Submit OS assignment"]);

    for (const day of [2, 3]) {
      world.advanceTo(at(day, "07:30"));
      const silentMorning = await sweepProfileA(world);
      expect(silentMorning.profiles[0]).toMatchObject({ selected: 0, delivered: 0, suppressed: day - 1, failed: 0 });
      expect(world.messages).toHaveLength(messageCountBeforeSuppression);
      expect(world.nudgedCount(sleepId)).toBe(1);
      const sleepChecks = world.checksForLoop(sleepId);
      expect(sleepChecks.filter((check) => check.status === "delivered")).toHaveLength(1);
      expect(sleepChecks.every((check) => check.status === "pending" || check.status === "delivered")).toBe(true);
    }

    world.advanceTo(at(3, "20:00"));
    expect(await world.contextLoopTitles()).not.toContain("Sleep before midnight");
    const lift = await world.agent.suppress({ subject: "sleep   BEFORE midnight", lift: true });
    expect(lift).toMatchObject({ status: "lifted", subject: "sleep before midnight", liftedCount: 1 });
    expect(world.rows.loop_suppressions.filter((row) => row.lifted_at === null)).toHaveLength(0);
    expect(await world.contextLoopTitles()).toContain("Sleep before midnight");

    await world.agent.scheduleFollowUp(sleepId, at(4, "06:00"));
    world.advanceTo(at(4, "07:30"));
    const friday = await sweepProfileA(world);
    expect(friday.profiles[0]).toMatchObject({ selected: 3, delivered: 3, suppressed: 0 });
    expect(world.messages.at(-1)?.content).toContain("Sleep before midnight");
    expect(world.checksForLoop(sleepId).every((check) => check.status === "delivered")).toBe(true);
    expect(String(world.loops().find((loop) => loop.id === assignmentId)?.status)).toBe("open");
  });

  it("edge: nine checks due one morning deliver eight under the shared cap and the ninth lands next morning", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const ids = [];
    for (let index = 1; index <= 9; index += 1) {
      ids.push(await world.agent.trackCommitment({ title: `Task ${index}`, dueAt: at(2, "08:00") }));
    }

    world.advanceTo(at(2, SWEEP_TIME));
    const cappedDay = await world.sweep({ profiles: ["profile-a"], limitPerProfile: 8 });
    expect(cappedDay.profiles[0]).toMatchObject({ selected: 8, delivered: 8, mergedBatches: 2 });
    expect(world.messages).toHaveLength(2);
    expect(world.checksForLoop(ids[8])[0]).toMatchObject({ status: "pending" });

    world.advanceTo(at(3, SWEEP_TIME));
    const nextMorning = await world.sweep({ profiles: ["profile-a"] });
    expect(nextMorning.profiles[0]).toMatchObject({ selected: 1, delivered: 1 });
    expect(world.checksForLoop(ids[8])[0]).toMatchObject({ status: "delivered", attempt_count: 1 });
  });

  it("edge: composing falls back to tier 0 text when the tier-1 composer fails mid-simulation", async () => {
    const failingComposer = async () => {
      throw new Error("model down");
    };
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    await world.agent.trackCommitment({ title: "Renew passport", dueAt: at(2, "08:00") });
    await world.agent.trackCommitment({ title: "Buy stamps", dueAt: at(2, "08:00") });

    world.advanceTo(at(2, SWEEP_TIME));
    const fallback = await composeCheckinMessage({ kind: "merged_batch", loops: [{ title: "Renew passport" }, { title: "Buy stamps" }], composer: failingComposer });
    expect(fallback.tier).toBe(0);
    expect(fallback.text).toContain("Renew passport");
    expect(fallback.text).toContain("Buy stamps");

    await world.sweep({ profiles: ["profile-a"] });
    expect(world.messages).toHaveLength(1);
    expect(world.deliveryLog).toHaveLength(2);
  });

  it("edge: two back-to-back sweeps at the same instant share one delivery per due check", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const passportId = await world.agent.trackCommitment({ title: "Renew passport", dueAt: at(2, "08:00") });
    const groceriesId = await world.agent.trackCommitment({ title: "Buy groceries", dueAt: at(2, "08:00") });

    world.advanceTo(at(2, SWEEP_TIME));
    const first = await world.sweep();
    const second = await world.sweep();

    expect(first.profiles).toHaveLength(2);
    expect(second.profiles.map((entry) => entry.selected)).toEqual([0, 0]);
    expect(world.messages).toHaveLength(1);
    expect(world.composerRequests).toEqual([{ kind: "merged_batch", titles: ["Renew passport", "Buy groceries"] }]);
    const expectedCheckIds = [passportId, groceriesId].flatMap((loopId) => world.checksForLoop(loopId).map((check) => String(check.id))).sort();
    expect(world.deliveryLog.map((entry) => entry.checkId).sort()).toEqual(expectedCheckIds);
    for (const loopId of [passportId, groceriesId]) {
      expect(world.checksForLoop(loopId)[0]).toMatchObject({ status: "delivered", attempt_count: 1 });
      expect(world.nudgedCount(loopId)).toBe(1);
    }
  });

  it("edge: a crashed batch holds its claim through the stale window and retries exactly once", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const loopId = await world.agent.trackCommitment({ title: "Crash candidate", dueAt: at(2, "08:00") });

    world.advanceTo(at(2, SWEEP_TIME));
    let writeAttempts = 0;
    const crashingWriter = async () => {
      writeAttempts += 1;
      throw new Error("process died mid-delivery");
    };
    const crashed = await runAccountabilitySweep({
      now: world.now,
      profiles: ["profile-a"],
      repository: world.repository,
      messageWriter: crashingWriter,
      threadLister: (async () => [{ id: THREAD_A }]) as never,
    });
    expect(crashed.profiles[0]).toMatchObject({ selected: 1, delivered: 0, failed: 1 });
    expect(writeAttempts).toBe(1);
    expect(world.messages).toHaveLength(0);
    const [claimedCheck] = world.checksForLoop(loopId);
    expect(claimedCheck).toMatchObject({ status: "pending", attempt_count: 0, claimed_at: at(2, SWEEP_TIME) });

    world.advanceTo(at(2, "09:35"));
    const tooSoon = await world.sweep({ profiles: ["profile-a"] });
    expect(tooSoon.profiles[0]).toMatchObject({ selected: 0, delivered: 0, cancelledOrphans: 1 });
    expect(world.messages).toHaveLength(0);
    expect(world.checksForLoop(loopId)[0]).toMatchObject({ status: "pending" });

    world.advanceTo(at(2, "09:41"));
    const retried = await world.sweep({ profiles: ["profile-a"] });
    expect(retried.profiles[0]).toMatchObject({ selected: 1, delivered: 1, mergedBatches: 1 });
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).toContain("Crash candidate");
    expect(world.checksForLoop(loopId)).toHaveLength(1);
    expect(world.checksForLoop(loopId)[0]).toMatchObject({ status: "delivered", attempt_count: 1, delivered_at: at(2, "09:41") });
    expect(world.nudgedCount(loopId)).toBe(1);
  });

  it("edge: orphaned pending deliveries age into cancellation with a sweep_retry marker", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const loopId = await world.agent.trackCommitment({ title: "Orphan witness", dueAt: at(2, "08:00") });

    world.rows.checkin_deliveries.push({
      id: "00000000-0000-4000-8004-000000000099",
      profile_id: "profile-a",
      thread_id: THREAD_A,
      message_id: null,
      summary: null,
      status: "pending",
      created_at: at(2, "08:10"),
      delivered_at: null,
      answered_at: null,
    });

    world.advanceTo(at(2, "08:30"));
    const early = await world.sweep({ profiles: ["profile-a"] });
    expect(early.profiles[0]).toMatchObject({ delivered: 1, cancelledOrphans: 0 });
    const orphan = () => world.deliveries().find((delivery) => delivery.id === "00000000-0000-4000-8004-000000000099");
    expect(orphan()).toMatchObject({ status: "pending" });
    expect(world.messages.some((message) => message.content.includes("Orphan witness"))).toBe(true);
    expect(world.checksForLoop(loopId)[0]).toMatchObject({ status: "delivered" });

    world.rows.checkin_deliveries.push({
      id: "00000000-0000-4000-8004-000000000100",
      profile_id: "profile-a",
      thread_id: THREAD_A,
      message_id: null,
      summary: null,
      status: "pending",
      created_at: at(0, "10:00"),
      delivered_at: null,
      answered_at: null,
    });

    world.advanceTo(at(2, "09:15"));
    const cleanup = await world.sweep({ profiles: ["profile-a"] });
    expect(cleanup.profiles[0].cancelledOrphans).toBe(2);
    expect(orphan()).toMatchObject({ status: "cancelled", summary: "sweep_retry" });
    expect(String(world.loopByTitle("Orphan witness")?.status)).toBe("open");
    expect(world.nudgedCount(loopId)).toBe(1);
  });

  it("scenario 10: a completion mentioned casually days earlier turns the overdue sweep into a soft-close confirm", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const assignmentId = await world.agent.trackCommitment({ title: "Submit OS assignment", dueAt: at(1, "08:00") });

    world.advanceTo(at(2, "15:00"));
    const casualThreadMessageId = "00000000-0000-4000-8000-0000000000e1";
    world.reconcile.setHistory([{
      messageId: casualThreadMessageId,
      threadId: THREAD_B,
      content: "btw I finally submitted the OS assignment this morning",
      createdAt: at(2, "15:00"),
    }]);
    world.reconcile.setClassification({ completed: true, confidence: 0.92, supportingIndex: 0 });

    const [loopRow] = world.loops();
    expect(loopRow).toMatchObject({ title: "Submit OS assignment", status: "open", created_at: "2026-08-01T00:00:00.000Z" });

    world.advanceTo(at(4, SWEEP_TIME));
    const late = await sweepProfileA(world);
    expect(late.profiles[0]).toMatchObject({ selected: 1, delivered: 1, failed: 0 });
    expect(world.composerRequests).toHaveLength(0);
    expect(world.reconcile.searchCalls).toEqual([
      { profileId: "profile-a", query: "Submit OS assignment", from: String(loopRow.created_at) },
    ]);
    expect(world.reconcile.classifyCalls).toEqual([
      { title: "Submit OS assignment", candidates: [expect.objectContaining({ messageId: casualThreadMessageId })] },
    ]);
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).toContain("Submit OS assignment");
    expect(world.messages[0].content).toContain("submitted the OS assignment");
    expect(world.messages[0].content).toMatch(/close/i);
    expect(String(world.loopByTitle("Submit OS assignment")?.status)).toBe("open");
    expect(world.checksForLoop(assignmentId)[0]).toMatchObject({ status: "delivered", attempt_count: 1, escalation_tier: 1 });
    expect(world.nudgedCount(assignmentId)).toBe(1);
  });

  it("scenario 11: when reconciliation finds no stated completion the overdue sweep stays a normal catch-up nudge", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    await world.agent.trackCommitment({ title: "Book dentist", dueAt: at(1, "08:00") });

    world.advanceTo(at(4, SWEEP_TIME));
    world.reconcile.setHistory([{
      messageId: "00000000-0000-4000-8000-0000000000e2",
      threadId: THREAD_B,
      content: "still thinking about which dentist to pick",
      createdAt: at(3, "12:00"),
    }]);
    world.reconcile.setClassification({ completed: false, confidence: 0.9 });

    const overdue = await sweepProfileA(world);
    expect(overdue.profiles[0]).toMatchObject({ selected: 1, delivered: 1, failed: 0 });
    expect(world.reconcile.classifyCalls).toHaveLength(1);
    expect(world.composerRequests).toEqual([{ kind: "catch_up", titles: ["Book dentist"] }]);
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0].content).toBe("[catch_up] Book dentist");
    expect(String(world.loopByTitle("Book dentist")?.status)).toBe("open");
    expect(world.checksForLoop(String(world.loopByTitle("Book dentist")?.id))[0]).toMatchObject({ status: "delivered" });
  });

  it("edge: a low-confidence completion never soft-closes and still nudges normally", async () => {
    const world = createWorld();
    world.advanceTo(at(0, "10:00"));
    const loopId = await world.agent.trackCommitment({ title: "Renew passport", dueAt: at(1, "08:00") });

    world.advanceTo(at(4, SWEEP_TIME));
    world.reconcile.setHistory([{
      messageId: "00000000-0000-4000-8000-0000000000e3",
      threadId: THREAD_B,
      content: "passport stuff is maybe handled?",
      createdAt: at(3, "09:00"),
    }]);
    world.reconcile.setClassification({ completed: true, confidence: 0.55 });

    const uncertain = await sweepProfileA(world);
    expect(uncertain.profiles[0]).toMatchObject({ delivered: 1 });
    expect(world.composerRequests).toEqual([{ kind: "catch_up", titles: ["Renew passport"] }]);
    expect(String(world.loops().find((loop) => loop.id === loopId)?.status)).toBe("open");
  });
});
