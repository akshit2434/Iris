import { describe, expect, it, vi } from "vitest";
import { createMessage, listThreads } from "@/server/db/queries";
import {
  composeCheckinMessage,
  composeTier0Text,
  createProductionCheckinComposer,
} from "@/server/accountability/composer";
import {
  DEFAULT_LIMIT_PER_PROFILE,
  SWEEP_MAX_BATCH,
  runAccountabilitySweep,
  selectCheckinKind,
  type SweepThreadLister,
} from "@/server/accountability/sweeper";
import type {
  AccountabilityRepository,
  DeliverableDueCheck,
  LoopEventActor,
  OpenLoopRow,
  ScheduledCheckRow,
} from "@/server/accountability/repository";

vi.mock("@/server/db/queries", () => ({
  createMessage: vi.fn(async (input: { id: string }) => ({ ...input, createdAt: "2026-08-22T08:30:00.000Z" })),
  listThreads: vi.fn(async () => []),
}));

const NOW = "2026-08-22T08:30:00.000Z";
const THREAD_ID = "00000000-0000-4000-8000-000000000001";

let sequence = 0;

function makeLoop(overrides: Partial<OpenLoopRow> = {}): OpenLoopRow {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    profileId: "profile-a",
    title: "Renew passport",
    details: null,
    kind: "commitment",
    status: "open",
    dueAt: "2026-08-21T09:00:00.000Z",
    cadence: null,
    originThreadId: null,
    originMessageId: null,
    createdAt: "2026-08-15T10:00:00.000Z",
    updatedAt: "2026-08-15T10:00:00.000Z",
    closedAt: null,
    ...overrides,
  };
}

function makeCheck(loopId: string, dueAt: string, overrides: Partial<ScheduledCheckRow> = {}): ScheduledCheckRow {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8001-${String(sequence).padStart(12, "0")}`,
    profileId: "profile-a",
    loopId,
    dueAt,
    status: "pending",
    attemptCount: 0,
    escalationTier: 0,
    deliveryId: null,
    deliveredAt: null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

function makePair(loopOverrides: Partial<OpenLoopRow> = {}, checkOverrides: Partial<ScheduledCheckRow> = {}): DeliverableDueCheck {
  const loop = makeLoop(loopOverrides);
  const check = makeCheck(loop.id, loop.dueAt ?? NOW, checkOverrides);
  return { loop, check };
}

const REPOSITORY_METHODS = [
  "listOpenLoops",
  "getOpenLoop",
  "insertOpenLoop",
  "updateOpenLoopStatus",
  "insertLoopEvent",
  "listDueChecks",
  "listDeliverableDueChecks",
  "markCheckDelivered",
  "insertScheduledCheck",
  "cancelPendingChecksForLoop",
  "insertDelivery",
  "markDeliveryDelivered",
] as const;

function fakeRepository(pairs: DeliverableDueCheck[] = [], overrides: Partial<AccountabilityRepository> = {}): AccountabilityRepository {
  let deliverySequence = 0;
  const base = {
    listOpenLoops: vi.fn(async () => []),
    getOpenLoop: vi.fn(async () => null),
    insertOpenLoop: vi.fn(async () => makeLoop()),
    updateOpenLoopStatus: vi.fn(async () => makeLoop()),
    insertLoopEvent: vi.fn((_profileId: string, input: { loopId: string; kind: string; actor?: LoopEventActor }) => ({
      id: `event-${++deliverySequence}`,
      profileId: "profile-a" as const,
      loopId: input.loopId,
      kind: input.kind as never,
      detail: null,
      actor: (input.actor ?? "system") as LoopEventActor,
      sourceThreadId: null,
      sourceMessageId: null,
      agentRunId: null,
      metadata: {},
      createdAt: NOW,
    })),
    listDueChecks: vi.fn(async () => []),
    listDeliverableDueChecks: vi.fn(async () => pairs),
    markCheckDelivered: vi.fn(async (_profileId: string, checkId: string, input: { attemptCount: number; escalationTier: number }) => {
      const found = pairs.find((pair) => pair.check.id === checkId);
      return (found?.check ?? makeCheck(checkId, NOW));
    }),
    insertScheduledCheck: vi.fn(async () => makeCheck("generated-check", NOW)),
    cancelPendingChecksForLoop: vi.fn(async () => 0),
    insertDelivery: vi.fn(async (_profileId: string, _input: { threadId: string }) => {
      deliverySequence += 1;
      return {
        id: `delivery-${deliverySequence}`,
        profileId: "profile-a" as const,
        threadId: THREAD_ID,
        messageId: null,
        summary: null,
        status: "pending" as const,
        createdAt: NOW,
        deliveredAt: null,
        answeredAt: null,
      };
    }),
    markDeliveryDelivered: vi.fn(async (_profileId: string, deliveryId: string, input: { messageId: string }) => ({
      id: deliveryId,
      profileId: "profile-a" as const,
      threadId: THREAD_ID,
      messageId: input.messageId,
      summary: null,
      status: "delivered" as const,
      createdAt: NOW,
      deliveredAt: NOW,
      answeredAt: null,
    })),
    ...overrides,
  };
  return base as unknown as AccountabilityRepository;
}

const liveThreads: SweepThreadLister = async () => [{ id: THREAD_ID }];

describe("check-in composer", () => {
  it("answers a single fresh commitment with a warm Tier 0 template and zero model calls", async () => {
    const composer = vi.fn(async () => "model text");
    const result = await composeCheckinMessage({
      kind: "single_commitment",
      loops: [{ title: "Renew passport" }],
      composer,
    });
    expect(result.tier).toBe(0);
    expect(result.text).toMatch(/Quick check/i);
    expect(result.text).toContain("Renew passport");
    expect(composer).not.toHaveBeenCalled();
  });

  it("uses the Tier 1 composer for merges, routines, and catch-ups", async () => {
    const composer = vi.fn(async (request: { loops: Array<{ title: string }> }) => `Composed nudge for ${request.loops.length}.`);
    for (const kind of ["merged_batch", "routine_reflection", "catch_up"] as const) {
      const result = await composeCheckinMessage({ kind, loops: [{ title: "Renew passport" }], composer });
      expect(result).toEqual({ text: "Composed nudge for 1.", tier: 1 });
    }
    expect(composer).toHaveBeenCalledTimes(3);
    expect(composer.mock.calls.every((call) => String(call[0].loops[0].title) === "Renew passport")).toBe(true);
  });

  it("falls back to Tier 0 phrasing when the composer fails or times out", async () => {
    const failing: Parameters<typeof composeCheckinMessage>[0]["composer"] = async () => {
      throw new Error("provider down");
    };
    const result = await composeCheckinMessage({ kind: "routine_reflection", loops: [{ title: "DSA practice" }], composer: failing });
    expect(result.tier).toBe(0);
    expect(result.text).toContain("DSA practice");
    expect(composeTier0Text({ kind: "catch_up", loops: [{ title: "Tax filing" }] })).toContain("Tax filing");
  });

  it("builds the production composer like the title model factory", () => {
    const envKey = "OPENROUTER_" + "API_KEY";
    const previousKey = process.env[envKey];
    delete process.env[envKey];
    try {
      expect(() => createProductionCheckinComposer()).toThrow(new RegExp(envKey));
    } finally {
      if (previousKey === undefined) delete process.env[envKey];
      else process.env[envKey] = previousKey;
    }
  });
});

describe("accountability sweep", () => {
  it("merges two commitments due the same morning into one delivered check-in", async () => {
    const morning = makePair({ title: "Renew passport" }, { dueAt: "2026-08-22T08:00:00.000Z" });
    const groceries = makePair({ title: "Buy groceries" }, { dueAt: "2026-08-22T09:00:00.000Z" });
    const repository = fakeRepository([morning, groceries]);
    const composer = vi.fn(async () => "Both are due today — how did each go?");
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      composer,
      threadLister: liveThreads,
    });
    expect(report.profiles).toHaveLength(1);
    expect(report.profiles[0]).toEqual({ profileId: "profile-a", selected: 2, delivered: 2, mergedBatches: 1, cancelledStale: 0, skippedNoThread: 0 });
    expect(report.at).toBe(NOW);
    expect(repository.insertDelivery).toHaveBeenCalledTimes(1);
    expect(repository.insertDelivery).toHaveBeenCalledWith("profile-a", { threadId: THREAD_ID });
    expect(composer).toHaveBeenCalledWith({ kind: "merged_batch", loops: [{ title: "Renew passport" }, { title: "Buy groceries" }] });
    expect(repository.markDeliveryDelivered).toHaveBeenCalledWith("profile-a", "delivery-1", { messageId: expect.any(String) });
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(2);
    const deliveries = vi.mocked(repository.markCheckDelivered).mock.calls.map((call) => call[2].deliveryId);
    expect(new Set(deliveries)).toEqual(new Set(["delivery-1"]));
    expect(repository.insertLoopEvent).toHaveBeenCalledTimes(2);
    for (const pair of [morning, groceries]) {
      expect(repository.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({
        loopId: pair.loop.id,
        kind: "nudged",
        actor: "system",
        sourceThreadId: null,
        sourceMessageId: null,
        agentRunId: null,
      }));
    }
    expect(vi.mocked(repository.markCheckDelivered).mock.calls.every((call) => call[2].attemptCount === 1 && call[2].escalationTier === 0)).toBe(true);
  });

  it("caps every merged delivery at four items while preserving due_at order", async () => {
    const hours = ["04:00:00", "05:00:00", "06:00:00", "07:00:00", "08:00:00"];
    const pairs = hours.map((hour, index) => makePair({ title: `Task ${index + 1}` }, { dueAt: `2026-08-22T${hour}.000Z` }));
    const repository = fakeRepository(pairs);
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer: async () => "nudge", threadLister: liveThreads });
    expect(SWEEP_MAX_BATCH).toBe(4);
    expect(report.profiles[0]).toMatchObject({ selected: 5, delivered: 5, mergedBatches: 2 });
    expect(repository.insertDelivery).toHaveBeenCalledTimes(2);
    const deliveredOrder = vi.mocked(repository.markCheckDelivered).mock.calls.map((call) => call[1]);
    const expectedOrder = pairs.map((pair) => pair.check.id);
    expect(deliveredOrder).toEqual(expectedOrder);
  });

  it("greets a single fresh commitment with the Tier 0 template and never wakes the model", async () => {
    const repository = fakeRepository([makePair({ title: "Submit OS assignment", dueAt: "2026-08-21T09:00:00.000Z" })]);
    const composer = vi.fn(async () => "unused");
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer, threadLister: liveThreads });
    expect(composer).not.toHaveBeenCalled();
    expect(report.profiles[0]).toMatchObject({ selected: 1, delivered: 1, mergedBatches: 1 });
    expect(repository.markDeliveryDelivered).toHaveBeenCalledWith("profile-a", "delivery-1", { messageId: expect.any(String) });
    const written = vi.mocked(repository.markDeliveryDelivered).mock.invocationCallOrder;
    expect(written.length).toBeGreaterThan(0);
    expect(selectCheckinKind([{ kind: "commitment", dueAt: "2026-08-21T09:00:00.000Z" }], NOW)).toBe("single_commitment");
  });

  it("sends routine reflections through the Tier 1 composer", async () => {
    const repository = fakeRepository([
      makePair({ title: "Weekly review", kind: "routine", cadence: { kind: "weekly" }, dueAt: "2026-08-22T08:00:00.000Z" }),
    ]);
    const composer = vi.fn(async () => "How did the weekly review feel?");
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer, threadLister: liveThreads });
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ kind: "routine_reflection", loops: [{ title: "Weekly review" }] }));
  });

  it("switches to catch-up phrasing only after two overdue days against the injected now", async () => {
    const twoDays = makePair({ title: "Edge loop", dueAt: "2026-08-20T08:30:00.000Z" });
    const threeDays = makePair({ title: "Late loop", dueAt: "2026-08-19T08:30:00.000Z" });
    const composer = vi.fn(async () => "catch-up text");

    const boundary = fakeRepository([twoDays]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository: boundary, composer, threadLister: liveThreads });
    expect(composer).not.toHaveBeenCalled();

    const overdue = fakeRepository([threeDays]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository: overdue, composer, threadLister: liveThreads });
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ kind: "catch_up" }));
    expect(selectCheckinKind([{ kind: "commitment", dueAt: "2026-08-19T08:30:00.000Z" }], NOW)).toBe("catch_up");
  });

  it("bumps attempt and escalation counters exactly once per delivery", async () => {
    const pair = makePair({}, { attemptCount: 1, escalationTier: 0, dueAt: "2026-08-22T08:00:00.000Z" });
    const repository = fakeRepository([pair]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", pair.check.id, expect.objectContaining({
      attemptCount: 2,
      escalationTier: 1,
    }));
  });

  it("cancels pending checks whose parent loop is no longer open", async () => {
    const closed = makePair({ title: "Finished thing", status: "done", closedAt: "2026-08-21T10:00:00.000Z" });
    const alive = makePair({ title: "Still open" });
    const repository = fakeRepository([closed, alive], { cancelPendingChecksForLoop: vi.fn(async () => 2) });
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", closed.loop.id, expect.stringMatching(/closed|paused/i));
    expect(report.profiles[0]).toMatchObject({ cancelledStale: 2, selected: 1, delivered: 1 });
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", alive.check.id, expect.anything());
  });

  it("leaves everything pending when the profile has no live thread", async () => {
    const repository = fakeRepository([makePair(), makePair({ title: "Second" })]);
    const threadLister = vi.fn(async () => []);
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister });
    expect(report.profiles[0]).toMatchObject({ selected: 2, delivered: 0, mergedBatches: 0, skippedNoThread: 2 });
    expect(threadLister).toHaveBeenCalledWith("profile-a");
    expect(repository.insertDelivery).not.toHaveBeenCalled();
    expect(repository.markCheckDelivered).not.toHaveBeenCalled();
    expect(repository.insertLoopEvent).not.toHaveBeenCalled();
  });

  it("persists sweep messages as complete assistant turns with no agent run", async () => {
    vi.mocked(createMessage).mockClear();
    vi.mocked(listThreads).mockResolvedValue([{ id: THREAD_ID }] as never);
    const repository = fakeRepository([makePair({ title: "Default writer loop" })]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(createMessage).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "profile-a",
      threadId: THREAD_ID,
      role: "assistant",
      agentRunId: null,
      isComplete: true,
    }));
    expect(repository.markDeliveryDelivered).toHaveBeenCalledWith("profile-a", "delivery-1", { messageId: expect.any(String) });
  });

  it("defaults to sweeping every profile under the shared limit", async () => {
    const repository = fakeRepository([]);
    const report = await runAccountabilitySweep({ now: NOW, repository, threadLister: liveThreads });
    expect(DEFAULT_LIMIT_PER_PROFILE).toBe(8);
    expect(repository.listDeliverableDueChecks).toHaveBeenCalledWith("profile-a", NOW, 8);
    expect(repository.listDeliverableDueChecks).toHaveBeenCalledWith("profile-b", NOW, 8);
    expect(report.profiles.map((entry) => entry.profileId)).toEqual(["profile-a", "profile-b"]);
    expect(report.profiles.every((entry) => entry.selected === 0)).toBe(true);
  });
});
