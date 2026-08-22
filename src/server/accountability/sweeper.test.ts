import { describe, expect, it, vi } from "vitest";
import { createMessage, listThreads } from "@/server/db/queries";
import { BRIEFING_LOOP_TITLE } from "@/server/accountability/briefing";
import {
  composeCheckinMessage,
  composeTier0Text,
  createProductionCheckinComposer,
  toneTierForEscalation,
  truncateAtWordBoundary,
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
import type {
  CommitmentSearchClient,
  CompletionClassifier,
} from "@/server/accountability/reconciler";

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
    claimedAt: null,
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
  "listDueChecksWithLoops",
  "claimDueChecks",
  "releaseClaims",
  "markCheckDelivered",
  "insertScheduledCheck",
  "cancelPendingChecksForLoop",
  "cancelOrphanPendingDeliveries",
  "insertDelivery",
  "insertDeliveryItems",
  "markDeliveryDelivered",
  "insertLoopSuppression",
  "liftLoopSuppression",
  "listActiveSuppressions",
] as const;

type SuppressionSeed = { id: string; profileId: "profile-a"; subject: string; reason: string; createdAt: string; liftedAt: null };

function makeSuppression(subject: string): SuppressionSeed {
  return { id: `sup-${subject.replace(/\s+/g, "-")}`, profileId: "profile-a", subject, reason: "r", createdAt: NOW, liftedAt: null };
}

function fakeRepository(pairs: DeliverableDueCheck[] = [], overrides: Partial<AccountabilityRepository> = {}): AccountabilityRepository {
  let deliverySequence = 0;
  const suppressions: SuppressionSeed[] = [];
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
    listDueChecksWithLoops: vi.fn(async () => pairs),
    claimDueChecks: vi.fn(async () => pairs),
    releaseClaims: vi.fn(async () => undefined),
    markCheckDelivered: vi.fn(async (_profileId: string, checkId: string, input: { attemptCount: number; escalationTier: number }) => {
      const found = pairs.find((pair) => pair.check.id === checkId);
      return { ...(found?.check ?? makeCheck(checkId, NOW)), attemptCount: input.attemptCount, escalationTier: input.escalationTier };
    }),
    insertScheduledCheck: vi.fn(async () => makeCheck("generated-check", NOW)),
    cancelPendingChecksForLoop: vi.fn(async () => 0),
    cancelOrphanPendingDeliveries: vi.fn(async () => 0),
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
  insertDeliveryItems: vi.fn(async () => undefined),
  listChecksForLoop: vi.fn(async () => []),
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
    insertLoopSuppression: vi.fn(async (_profileId: string, input: { subject: string }) => makeSuppression(input.subject)),
    liftLoopSuppression: vi.fn(async () => 1),
    listActiveSuppressions: vi.fn(async () => suppressions),
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
    expect(composeTier0Text({ kind: "catch_up", loops: [{ title: "Tax filing" }] })).toContain("its date");
  });

  it("pluralizes Tier 0 catch-up phrasing across multiple overdue loops", () => {
    const text = composeTier0Text({ kind: "catch_up", loops: [{ title: "Tax filing" }, { title: "Dentist booking" }] });
    expect(text).toContain("their dates");
    expect(text).toContain("pick them up");
  });

  it("composes the soft-close confirmation as deterministic Tier 0 text citing a bounded excerpt", async () => {
    const composer = vi.fn(async () => "model text");
    const result = await composeCheckinMessage({
      kind: "soft_close_confirm",
      loops: [{ title: "Renew passport", evidenceExcerpt: "finally submitted the passport renewal this morning btw" }],
      composer,
    });
    expect(result.tier).toBe(0);
    expect(result.text).toContain("Renew passport");
    expect(result.text).toContain("finally submitted the passport renewal");
    expect(result.text).toMatch(/close/i);
    expect(composer).not.toHaveBeenCalled();
  });

  it("caps soft-close evidence at eighty characters and falls back without an excerpt", () => {
    const quoted = composeTier0Text({
      kind: "soft_close_confirm",
      loops: [{ title: "Renew passport", evidenceExcerpt: "x".repeat(300) }],
    });
    expect(quoted).not.toContain("x".repeat(81));
    expect(quoted).toContain("Renew passport");
    const fallback = composeTier0Text({ kind: "soft_close_confirm", loops: [{ title: "Renew passport" }] });
    expect(fallback).toMatch(/did you get to Renew passport/i);
    expect(fallback).not.toMatch(/"/);
  });

  it("clamps escalation tiers into three tone buckets", () => {
    expect(toneTierForEscalation(0)).toBe(0);
    expect(toneTierForEscalation(1)).toBe(1);
    expect(toneTierForEscalation(2)).toBe(2);
    expect(toneTierForEscalation(5)).toBe(2);
    expect(toneTierForEscalation(-1)).toBe(0);
    expect(toneTierForEscalation(Number.NaN)).toBe(0);
  });

  it("softens to a gentle reminder at tier 1 and asks what changed with reschedule-or-drop at tier 2", async () => {
    const gentle = composeTier0Text({ kind: "single_commitment", loops: [{ title: "Renew passport" }], escalationTier: 1 });
    expect(gentle).toMatch(/gentle/i);
    expect(gentle).toContain("Renew passport");
    const slipping = await composeCheckinMessage({
      kind: "single_commitment",
      loops: [{ title: "Renew passport" }],
      escalationTier: 2,
      composer: async () => {
        throw new Error("model down");
      },
    });
    expect(slipping.tier).toBe(0);
    expect(slipping.text).toMatch(/keeps slipping/i);
    expect(slipping.text).toMatch(/still important/i);
    expect(slipping.text).toMatch(/reschedule/);
    expect(slipping.text).toMatch(/drop/);
    for (const text of [gentle, slipping.text]) {
      expect(text).not.toMatch(/streak|lazy|failed|disappoint|scold/i);
    }
  });

  it("reflects on the routine pattern instead of nagging when routines keep slipping", () => {
    const text = composeTier0Text({ kind: "routine_reflection", loops: [{ title: "Weekly review" }], escalationTier: 3 });
    expect(text).toContain("Weekly review");
    expect(text).toMatch(/still working for you/i);
    expect(text).toMatch(/adjust the rhythm/);
    expect(text).not.toMatch(/streak/i);
  });

  it("varies soft-close phrasing once a prior confirmation went unanswered", () => {
    const firstAsk = composeTier0Text({
      kind: "soft_close_confirm",
      loops: [{ title: "Renew passport", evidenceExcerpt: "finally submitted the passport renewal this morning btw" }],
      escalationTier: 0,
    });
    expect(firstAsk).toMatch(/want me to close it out/i);
    const repeat = composeTier0Text({
      kind: "soft_close_confirm",
      loops: [{ title: "Renew passport", evidenceExcerpt: "finally submitted the passport renewal this morning btw" }],
      escalationTier: 2,
    });
    expect(repeat).toMatch(/still seeing/i);
    expect(repeat).toMatch(/close it for good/i);
    expect(repeat).not.toBe(firstAsk);
  });

  it("passes the batch escalation tier through to the injected composer", async () => {
    const composer = vi.fn(async () => "model nudge");
    await composeCheckinMessage({ kind: "merged_batch", loops: [{ title: "A" }], escalationTier: 3, composer });
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ escalationTier: 3 }));
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

  it("truncates oversized generated text at the last word boundary", () => {
    expect(truncateAtWordBoundary("short nudge", 100)).toBe("short nudge");
    expect(truncateAtWordBoundary("alpha beta gamma delta", 15)).toBe("alpha beta");
    expect(truncateAtWordBoundary("first line\nsecond line", 14)).toBe("first line");
    const noSpaces = "x".repeat(50);
    expect(truncateAtWordBoundary(noSpaces, 20)).toBe("x".repeat(20));
    expect(truncateAtWordBoundary("ends with space ", 12)).toBe("ends with");
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
    expect(report.profiles[0]).toEqual({ profileId: "profile-a", selected: 2, delivered: 2, mergedBatches: 1, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 });
    expect(report.at).toBe(NOW);
    expect(repository.insertDelivery).toHaveBeenCalledTimes(1);
    expect(repository.insertDelivery).toHaveBeenCalledWith("profile-a", { threadId: THREAD_ID });
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ kind: "merged_batch", loops: [{ title: "Renew passport" }, { title: "Buy groceries" }] }));
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
    expect(vi.mocked(repository.markCheckDelivered).mock.calls.every((call) => call[2].attemptCount === 1 && call[2].escalationTier === 1)).toBe(true);
  });

  it("seeds one delivery item per loop inside each delivery before anything is marked delivered", async () => {
    const pairs = [
      makePair({ title: "Renew passport" }, { dueAt: "2026-08-22T08:00:00.000Z" }),
      makePair({ title: "Buy groceries" }, { dueAt: "2026-08-22T09:00:00.000Z" }),
      makePair({ title: "Call plumber" }, { dueAt: "2026-08-22T10:00:00.000Z" }),
      makePair({ title: "Task 4" }, { dueAt: "2026-08-22T11:00:00.000Z" }),
      makePair({ title: "Task 5" }, { dueAt: "2026-08-22T12:00:00.000Z" }),
    ];
    const repository = fakeRepository(pairs);
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer: async () => "nudge", threadLister: liveThreads });
    expect(report.profiles[0]).toMatchObject({ selected: 5, delivered: 5, mergedBatches: 2, failed: 0 });
    const insertedDeliveryIds = vi.mocked(repository.markDeliveryDelivered).mock.calls.map((call) => call[1]);
    expect(repository.insertDeliveryItems).toHaveBeenCalledTimes(2);
    expect(repository.insertDeliveryItems).toHaveBeenNthCalledWith(1, "profile-a", insertedDeliveryIds[0], [
      pairs[0].loop.id,
      pairs[1].loop.id,
      pairs[2].loop.id,
      pairs[3].loop.id,
    ]);
    expect(repository.insertDeliveryItems).toHaveBeenNthCalledWith(2, "profile-a", insertedDeliveryIds[1], [pairs[4].loop.id]);
    const insertOrder = vi.mocked(repository.insertDelivery).mock.invocationCallOrder;
    const itemsOrder = vi.mocked(repository.insertDeliveryItems).mock.invocationCallOrder;
    const deliveredOrder = vi.mocked(repository.markDeliveryDelivered).mock.invocationCallOrder;
    expect(itemsOrder.every((order) => insertOrder.some((before) => before < order))).toBe(true);
    expect(deliveredOrder.every((order) => itemsOrder.some((before) => before < order))).toBe(true);
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
    const pair = makePair({}, { attemptCount: 1, escalationTier: 1, dueAt: "2026-08-22T08:00:00.000Z" });
    const repository = fakeRepository([pair]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", pair.check.id, expect.objectContaining({
      attemptCount: 2,
      escalationTier: 2,
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

  it("keeps later batches and other profiles moving when one batch fails", async () => {
    const hours = ["04:00:00", "05:00:00", "06:00:00", "07:00:00", "08:00:00"];
    const pairs = hours.map((hour, index) => makePair({ title: `Task ${index + 1}` }, { dueAt: `2026-08-22T${hour}.000Z` }));
    const writes: string[] = [];
    const flakyWriter = vi.fn(async (input: { profileId: string; content: string }) => {
      writes.push(`${input.profileId}:${input.content.length}`);
      if (writes.length === 1) throw new Error("transient write failure");
      return { id: `message-${writes.length}` };
    });
    const repository = fakeRepository(pairs, {
      claimDueChecks: vi.fn(async (profileId: string) => (profileId === "profile-a" ? pairs : [])),
    });
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a", "profile-b"],
      repository,
      messageWriter: flakyWriter,
      threadLister: liveThreads,
    });
    expect(report.profiles[0]).toMatchObject({ selected: 5, delivered: 1, mergedBatches: 1, failed: 1, skippedNoThread: 0 });
    expect(report.profiles[1]).toEqual({ profileId: "profile-b", selected: 0, delivered: 0, mergedBatches: 0, cancelledStale: 0, cancelledOrphans: 0, skippedNoThread: 0, suppressed: 0, failed: 0 });
    expect(repository.insertDelivery).toHaveBeenCalledTimes(2);
    expect(repository.markDeliveryDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", pairs[4].check.id, expect.objectContaining({ attemptCount: 1 }));
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
    expect(repository.claimDueChecks).toHaveBeenCalledWith("profile-a", NOW, 8);
    expect(repository.claimDueChecks).toHaveBeenCalledWith("profile-b", NOW, 8);
    expect(report.profiles.map((entry) => entry.profileId)).toEqual(["profile-a", "profile-b"]);
    expect(report.profiles.every((entry) => entry.selected === 0)).toBe(true);
  });

  it("emits the exact SweepReport contract the endpoint and Home card consume", async () => {
    const repository = fakeRepository([]);
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(Object.keys(report).sort()).toEqual(["at", "profiles"]);
    expect(Number.isNaN(Date.parse(report.at))).toBe(false);
    expect(report.profiles).toHaveLength(1);
    for (const entry of report.profiles) {
      expect(Object.keys(entry).sort()).toEqual([
        "cancelledOrphans",
        "cancelledStale",
        "delivered",
        "failed",
        "mergedBatches",
        "profileId",
        "selected",
        "skippedNoThread",
        "suppressed",
      ]);
      for (const counter of [entry.selected, entry.delivered, entry.mergedBatches, entry.cancelledStale, entry.cancelledOrphans, entry.skippedNoThread, entry.suppressed, entry.failed]) {
        expect(typeof counter).toBe("number");
        expect(Number.isInteger(counter)).toBe(true);
      }
    }
  });

  it("skips checks whose loop title matches an active suppression and releases their claims", async () => {
    const suppressedPair = makePair({ title: "Sleep Before Midnight", kind: "routine", cadence: { kind: "daily" } });
    const livePair = makePair({ title: "Buy groceries" }, { dueAt: "2026-08-22T09:00:00.000Z" });
    const repository = fakeRepository([suppressedPair, livePair], {
      listActiveSuppressions: vi.fn(async () => [makeSuppression("sleep before midnight")]),
    });
    const writtenTexts: string[] = [];
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      messageWriter: async (input) => {
        writtenTexts.push(input.content);
        return { id: `message-${writtenTexts.length}` };
      },
      threadLister: liveThreads,
    });
    expect(report.profiles[0]).toMatchObject({ selected: 1, delivered: 1, suppressed: 1, failed: 0 });
    expect(writtenTexts.join("\n")).toContain("Buy groceries");
    expect(writtenTexts.join("\n")).not.toContain("Sleep Before Midnight");
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", livePair.check.id, expect.anything());
    expect(repository.insertLoopEvent).toHaveBeenCalledTimes(1);
    expect(repository.releaseClaims).toHaveBeenCalledWith("profile-a", [suppressedPair.check.id]);
  });

  it("still cancels stale pending checks on suppressed loops and counts nothing delivered for them", async () => {
    const closedSuppressed = makePair({ title: "Old habit", status: "done", closedAt: "2026-08-21T10:00:00.000Z" });
    const repository = fakeRepository([closedSuppressed], {
      listActiveSuppressions: vi.fn(async () => [makeSuppression("old habit")]),
      cancelPendingChecksForLoop: vi.fn(async () => 1),
    });
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(report.profiles[0]).toMatchObject({ selected: 0, delivered: 0, suppressed: 0, cancelledStale: 1 });
    expect(repository.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", closedSuppressed.loop.id, expect.any(String));
    expect(repository.releaseClaims).not.toHaveBeenCalled();
  });

  it("releases claims instead of holding them when no thread is available", async () => {
    const pairs = [makePair({ title: "No thread yet" })];
    const repository = fakeRepository(pairs);
    const threadLister = vi.fn(async () => []);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister });
    expect(repository.releaseClaims).toHaveBeenCalledWith("profile-a", [pairs[0].check.id]);
  });

  it("cancels orphaned deliveries on every profile sight", async () => {
    const repository = fakeRepository([makePair()]);
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a", "profile-b"], repository, threadLister: liveThreads });
    expect(repository.cancelOrphanPendingDeliveries).toHaveBeenCalledWith("profile-a", NOW);
    expect(repository.cancelOrphanPendingDeliveries).toHaveBeenCalledWith("profile-b", NOW);
  });

  it("seeds a lazily created Morning briefing check due today at 08:00 when open loops exist", async () => {
    const briefingLoop = makeLoop({ id: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null });
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [makeLoop({ title: "Buy groceries" })]),
      insertOpenLoop: vi.fn(async () => briefingLoop),
    });
    const report = await runAccountabilitySweep({ now: "2026-08-21T06:30:00.000Z", profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertOpenLoop).toHaveBeenCalledWith(expect.objectContaining({
      profileId: "profile-a",
      title: BRIEFING_LOOP_TITLE,
      kind: "routine",
      cadence: { kind: "daily" },
    }));
    expect(repository.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: "loop-briefing", dueAt: "2026-08-21T08:00:00.000Z" });
    expect(report.profiles[0]).toMatchObject({ selected: 0, delivered: 0, failed: 0 });
  });

  it("targets tomorrow 08:00 when today's briefing slot is already past and still delivers the same sweep's other checks", async () => {
    const briefingLoop = makeLoop({ id: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null });
    const repository = fakeRepository([makePair({ title: "Renew passport" }, { dueAt: "2026-08-22T08:00:00.000Z" })], {
      listOpenLoops: vi.fn(async () => [makeLoop({ title: "Buy groceries" }), briefingLoop]),
      insertOpenLoop: vi.fn(async () => briefingLoop),
      listChecksForLoop: vi.fn(async () => []),
    });
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer: async () => "nudge", threadLister: liveThreads });
    expect(repository.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: "loop-briefing", dueAt: "2026-08-23T08:00:00.000Z" });
    expect(repository.markCheckDelivered).toHaveBeenCalledTimes(1);
  });

  it("never seeds a briefing when the only open loop is the reserved one", async () => {
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [makeLoop({ title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null })]),
    });
    await runAccountabilitySweep({ now: "2026-08-21T06:30:00.000Z", profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertOpenLoop).not.toHaveBeenCalled();
    expect(repository.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("cancels pending briefing checks once no non-briefing loop remains open", async () => {
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [makeLoop({ id: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null })]),
      listChecksForLoop: vi.fn(async () => [makeCheck("loop-briefing", "2026-08-21T08:00:00.000Z", { id: "check-orphan-briefing" })]),
      cancelPendingChecksForLoop: vi.fn(async () => 1),
    });
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", "loop-briefing", expect.stringMatching(/no open loops/i));
    expect(repository.insertOpenLoop).not.toHaveBeenCalled();
    expect(repository.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("skips reseeding while a briefing check is pending or was delivered today, then resumes the next day", async () => {
    const briefingLoop = makeLoop({ id: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null });
    let currentBriefingChecks: ScheduledCheckRow[] = [makeCheck("loop-briefing", "2026-08-22T08:00:00.000Z")];
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [makeLoop({ title: "Buy groceries" })]),
      insertOpenLoop: vi.fn(async () => briefingLoop),
      listChecksForLoop: vi.fn(async (_profileId: string, loopId: string) =>
        loopId === "loop-briefing" ? currentBriefingChecks : []) as never,
    });
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertScheduledCheck).not.toHaveBeenCalled();

    currentBriefingChecks = [{
      ...makeCheck("loop-briefing", "2026-08-22T08:00:00.000Z"),
      status: "delivered",
      deliveredAt: "2026-08-22T08:05:00.000Z",
    }];
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertScheduledCheck).not.toHaveBeenCalled();

    currentBriefingChecks = [{
      ...makeCheck("loop-briefing", "2026-08-21T08:00:00.000Z"),
      status: "delivered",
      deliveredAt: "2026-08-21T09:00:00.000Z",
    }];
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: "loop-briefing", dueAt: "2026-08-23T08:00:00.000Z" });
  });

  it("supersedes a stale unclaimed briefing check from an earlier day instead of delivering it late", async () => {
    const briefingLoop = makeLoop({ id: "loop-briefing", title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, dueAt: null });
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [makeLoop({ title: "Buy groceries" })]),
      insertOpenLoop: vi.fn(async () => briefingLoop),
      listChecksForLoop: vi.fn(async () => [
        makeCheck("loop-briefing", "2026-08-20T08:00:00.000Z", { id: "check-stale" }),
      ]),
      cancelPendingChecksForLoop: vi.fn(async () => 1),
    });
    await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.cancelPendingChecksForLoop).toHaveBeenCalledWith("profile-a", "loop-briefing", expect.stringMatching(/superseded/i));
    expect(repository.insertScheduledCheck).toHaveBeenCalledWith("profile-a", { loopId: "loop-briefing", dueAt: "2026-08-23T08:00:00.000Z" });
  });

  it("does not resurrect a closed or paused briefing loop", async () => {
    const repository = fakeRepository([], {
      listOpenLoops: vi.fn(async () => [
        makeLoop({ title: "Buy groceries" }),
        makeLoop({ title: BRIEFING_LOOP_TITLE, kind: "routine", cadence: { kind: "daily" }, status: "dropped", closedAt: NOW }),
      ]),
    });
    await runAccountabilitySweep({ now: "2026-08-21T06:30:00.000Z", profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertOpenLoop).not.toHaveBeenCalled();
    expect(repository.insertScheduledCheck).not.toHaveBeenCalled();
  });

  it("keeps sweeping when the reserved title matches no rows because profiles start clean", async () => {
    const repository = fakeRepository([]);
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, threadLister: liveThreads });
    expect(repository.insertOpenLoop).not.toHaveBeenCalled();
    expect(report.profiles[0]).toMatchObject({ failed: 0 });
  });

  it("soft-closes an overdue commitment whose completion was already stated elsewhere instead of nagging", async () => {
    const overdue = makePair({ title: "Renew passport", dueAt: "2026-08-19T09:00:00.000Z" });
    const repository = fakeRepository([overdue]);
    const retrieval: CommitmentSearchClient = vi.fn(async () => [{
      messageId: "00000000-0000-4000-8000-000000000010",
      threadId: "00000000-0000-4000-8000-000000000011",
      content: "finally submitted the passport renewal yesterday btw",
      createdAt: "2026-08-20T14:00:00.000Z",
    }]);
    const classifier: CompletionClassifier = vi.fn(async () => ({ completed: true, confidence: 0.9, supportingIndex: 0 }));
    const composer = vi.fn(async () => "model nudge text");
    const writtenTexts: string[] = [];
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      composer,
      messageWriter: async (input) => {
        writtenTexts.push(input.content);
        return { id: `message-${writtenTexts.length}` };
      },
      threadLister: liveThreads,
      retrieval,
      classifier,
    });
    expect(report.profiles[0]).toMatchObject({ selected: 1, delivered: 1, mergedBatches: 1, failed: 0 });
    expect(retrieval).toHaveBeenCalledWith(expect.objectContaining({ query: "Renew passport", from: overdue.loop.createdAt, limit: 3 }));
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(composer).not.toHaveBeenCalled();
    expect(writtenTexts).toHaveLength(1);
    expect(writtenTexts[0]).toContain("Renew passport");
    expect(writtenTexts[0]).toContain("finally submitted the passport renewal");
    expect(writtenTexts[0]).toMatch(/close/i);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", overdue.check.id, expect.objectContaining({ attemptCount: 1, escalationTier: 1 }));
    expect(repository.insertLoopEvent).toHaveBeenCalledWith("profile-a", expect.objectContaining({ loopId: overdue.loop.id, kind: "nudged", actor: "system" }));
    expect(vi.mocked(repository.updateOpenLoopStatus)).not.toHaveBeenCalled();
  });

  it("delivers a soft-close confirm and a normal merged batch as separate ordered messages in one sweep", async () => {
    const overdue = makePair({ title: "Renew passport", dueAt: "2026-08-19T09:00:00.000Z" });
    const morning = makePair({ title: "Buy groceries" }, { dueAt: "2026-08-22T08:00:00.000Z" });
    const evening = makePair({ title: "Call plumber" }, { dueAt: "2026-08-22T09:00:00.000Z" });
    const repository = fakeRepository([overdue, morning, evening]);
    const retrieval: CommitmentSearchClient = vi.fn(async () => [{
      messageId: "00000000-0000-4000-8000-000000000010",
      threadId: "00000000-0000-4000-8000-000000000011",
      content: "finally submitted the passport renewal yesterday btw",
      createdAt: "2026-08-20T14:00:00.000Z",
    }]);
    const classifier: CompletionClassifier = vi.fn(async () => ({ completed: true, confidence: 0.9, supportingIndex: 0 }));
    const composer = vi.fn(async ({ loops }: { loops: Array<{ title: string }> }) => `${loops.map((loop) => loop.title).join(" + ")} nudge`);
    const writtenTexts: string[] = [];
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      composer,
      messageWriter: async (input) => {
        writtenTexts.push(input.content);
        return { id: `message-${writtenTexts.length}` };
      },
      threadLister: liveThreads,
      retrieval,
      classifier,
    });
    expect(report.profiles[0]).toMatchObject({ selected: 3, delivered: 3, mergedBatches: 2, failed: 0 });
    expect(repository.insertDelivery).toHaveBeenCalledTimes(2);
    expect(writtenTexts).toHaveLength(2);
    expect(writtenTexts[0]).toContain("Renew passport");
    expect(writtenTexts[0]).toContain("finally submitted the passport renewal");
    expect(writtenTexts[0]).toMatch(/close/i);
    expect(writtenTexts[1]).toBe("Buy groceries + Call plumber nudge");
    expect(composer).toHaveBeenCalledTimes(1);
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({
      kind: "merged_batch",
      escalationTier: 0,
      loops: [{ title: "Buy groceries" }, { title: "Call plumber" }],
    }));
    const deliveredOrder = vi.mocked(repository.markCheckDelivered).mock.calls.map((call) => call[1]);
    expect(deliveredOrder).toEqual([overdue.check.id, morning.check.id, evening.check.id]);
  });

  it("escalates deterministic wording from stored check state without waking the model", async () => {
    const repeated = makePair({ title: "Renew passport" }, { attemptCount: 2, escalationTier: 2 });
    const repository = fakeRepository([repeated]);
    const composer = vi.fn(async () => "unused");
    const writtenTexts: string[] = [];
    const report = await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      composer,
      messageWriter: async (input) => {
        writtenTexts.push(input.content);
        return { id: `message-${writtenTexts.length}` };
      },
      threadLister: liveThreads,
    });
    expect(report.profiles[0]).toMatchObject({ selected: 1, delivered: 1, failed: 0 });
    expect(composer).not.toHaveBeenCalled();
    expect(writtenTexts[0]).toMatch(/keeps slipping/i);
    expect(writtenTexts[0]).toMatch(/reschedule/);
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", repeated.check.id, expect.objectContaining({
      attemptCount: 3,
      escalationTier: 3,
    }));
  });

  it("sends different text on the second ask than the first for an ignored loop", async () => {
    const pair = makePair({ title: "Water plants" });
    const repository = fakeRepository([pair], {
      markCheckDelivered: vi.fn(async (_profileId: string, _checkId: string, input: { attemptCount: number; escalationTier: number }) => {
        pair.check.attemptCount = input.attemptCount;
        pair.check.escalationTier = input.escalationTier;
        return { ...pair.check };
      }),
    });
    const composer = vi.fn(async () => "unused");
    const writtenTexts: string[] = [];
    for (let sweep = 0; sweep < 2; sweep += 1) {
      await runAccountabilitySweep({
        now: NOW,
        profiles: ["profile-a"],
        repository,
        composer,
        messageWriter: async (input) => {
          writtenTexts.push(input.content);
          return { id: `message-${writtenTexts.length}` };
        },
        threadLister: liveThreads,
      });
    }
    expect(writtenTexts).toHaveLength(2);
    expect(writtenTexts[0]).toMatch(/Quick check/i);
    expect(writtenTexts[1]).toMatch(/Gentle reminder/i);
    expect(writtenTexts[0]).not.toBe(writtenTexts[1]);
    const storedTiers = vi.mocked(repository.markCheckDelivered).mock.calls.map((call) => call[2].escalationTier);
    expect(storedTiers).toEqual([1, 2]);
  });

  it("keeps the catch-up nudge when reconciliation finds no stated completion", async () => {
    const overdue = makePair({ title: "Late loop", dueAt: "2026-08-18T09:00:00.000Z" });
    const repository = fakeRepository([overdue]);
    const retrieval: CommitmentSearchClient = vi.fn(async () => [{
      messageId: "00000000-0000-4000-8000-000000000010",
      threadId: "00000000-0000-4000-8000-000000000011",
      content: "thinking about the late loop again",
      createdAt: "2026-08-20T14:00:00.000Z",
    }]);
    const classifier: CompletionClassifier = vi.fn(async () => ({ completed: false, confidence: 0.9 }));
    const composer = vi.fn(async () => "catch-up text");
    const writtenTexts: string[] = [];
    await runAccountabilitySweep({
      now: NOW,
      profiles: ["profile-a"],
      repository,
      composer,
      messageWriter: async (input) => {
        writtenTexts.push(input.content);
        return { id: `message-${writtenTexts.length}` };
      },
      threadLister: liveThreads,
      retrieval,
      classifier,
    });
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(composer).toHaveBeenCalledWith(expect.objectContaining({ kind: "catch_up" }));
    expect(writtenTexts.join("\n")).toBe("catch-up text");
    expect(repository.markCheckDelivered).toHaveBeenCalledWith("profile-a", overdue.check.id, expect.anything());
  });

  it("never spends search or model calls on commitments inside the two-day window", async () => {
    const fresh = makePair({ title: "Fresh loop", dueAt: "2026-08-21T09:00:00.000Z" });
    const routine = makePair({ title: "Weekly review", kind: "routine", cadence: { kind: "weekly" }, dueAt: "2026-08-10T09:00:00.000Z" });
    const repository = fakeRepository([fresh, routine]);
    const retrieval: CommitmentSearchClient = vi.fn(async () => []);
    const classifier: CompletionClassifier = vi.fn(async () => ({ completed: true, confidence: 1 }));
    const composer = vi.fn(async () => "composed");
    const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer, threadLister: liveThreads, retrieval, classifier });
    expect(report.profiles[0]).toMatchObject({ selected: 2, delivered: 2 });
    expect(retrieval).not.toHaveBeenCalled();
    expect(classifier).not.toHaveBeenCalled();
  });

  it("falls back to normal nudges when the production reconciliation seams cannot be built", async () => {
    const envKey = "OPENROUTER_" + "API_KEY";
    const previousKey = process.env[envKey];
    delete process.env[envKey];
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    try {
      const overdue = makePair({ title: "Late loop", dueAt: "2026-08-18T09:00:00.000Z" });
      const repository = fakeRepository([overdue]);
      const composer = vi.fn(async () => "catch-up text");
      const report = await runAccountabilitySweep({ now: NOW, profiles: ["profile-a"], repository, composer, threadLister: liveThreads });
      expect(report.profiles[0]).toMatchObject({ selected: 1, delivered: 1, failed: 0 });
      expect(composer).toHaveBeenCalledWith(expect.objectContaining({ kind: "catch_up" }));
    } finally {
      if (previousKey === undefined) delete process.env[envKey];
      else process.env[envKey] = previousKey;
    }
  });
});
