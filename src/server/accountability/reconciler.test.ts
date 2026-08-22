import { describe, expect, it, vi } from "vitest";
import {
  RECONCILIATION_CANDIDATE_LIMIT,
  SOFT_CLOSE_CONFIDENCE_THRESHOLD,
  createProductionCompletionClassifier,
  createProductionCommitmentRetrieval,
  excerptForSoftClose,
  isReconciliationEligible,
  reconcileOverdueCommitments,
  type CompletionClassifier,
  type ReconciliationCandidate,
} from "@/server/accountability/reconciler";

vi.mock("server-only", () => ({}));

const NOW = "2026-08-22T09:30:00.000Z";

function makeLoop(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-0000000000a1",
    title: "Renew passport",
    kind: "commitment" as const,
    status: "open" as const,
    dueAt: "2026-08-19T09:00:00.000Z",
    createdAt: "2026-08-15T10:00:00.000Z",
    ...overrides,
  };
}

function candidate(overrides: Partial<ReconciliationCandidate> = {}): ReconciliationCandidate {
  return {
    messageId: "00000000-0000-4000-8000-0000000000c1",
    threadId: "00000000-0000-4000-8000-0000000000b1",
    content: "finally submitted the passport renewal this morning btw",
    createdAt: "2026-08-20T14:00:00.000Z",
    ...overrides,
  };
}

describe("soft-close reconciliation", () => {
  it("flags only open commitments overdue beyond two days", () => {
    expect(isReconciliationEligible(makeLoop(), NOW)).toBe(true);
    const exactlyTwoDays = makeLoop({ dueAt: "2026-08-20T09:30:00.000Z" });
    expect(isReconciliationEligible(exactlyTwoDays, NOW)).toBe(false);
    expect(isReconciliationEligible(makeLoop({ dueAt: null }), NOW)).toBe(false);
    expect(isReconciliationEligible(makeLoop({ kind: "routine", cadence: { kind: "daily" } }), NOW)).toBe(false);
    expect(isReconciliationEligible(makeLoop({ kind: "idea" }), NOW)).toBe(false);
    expect(isReconciliationEligible(makeLoop({ status: "paused" }), NOW)).toBe(false);
    expect(isReconciliationEligible(makeLoop({ status: "done", closedAt: NOW }), NOW)).toBe(false);
  });

  it("returns no plan when history has no candidates for the loop title", async () => {
    const retrieval = vi.fn(async () => []);
    const classifier = vi.fn(async () => ({ completed: true, confidence: 0.99 }));
    const plans = await reconcileOverdueCommitments({
      profileId: "profile-a",
      loops: [makeLoop()],
      now: NOW,
      retrieval,
      classifier,
    });
    expect(plans.size).toBe(0);
    expect(retrieval).toHaveBeenCalledWith({
      profileId: "profile-a",
      query: "Renew passport",
      from: "2026-08-15T10:00:00.000Z",
      limit: RECONCILIATION_CANDIDATE_LIMIT,
    });
    expect(classifier).not.toHaveBeenCalled();
  });

  it("searches since loop creation, capped at three candidates, and soft-closes confident completions with an evidence excerpt", async () => {
    const evidence = candidate();
    const retrieval = vi.fn(async ({ limit }: { limit: number }) => [evidence].slice(0, limit));
    const classifier = vi.fn(async (input: { candidates: ReconciliationCandidate[] }) => ({
      completed: input.candidates.length > 0 && input.candidates[0] === evidence ? true : false,
      confidence: 0.86,
    }));
    const plans = await reconcileOverdueCommitments({
      profileId: "profile-a",
      loops: [makeLoop()],
      now: NOW,
      retrieval,
      classifier,
    });
    expect(RECONCILIATION_CANDIDATE_LIMIT).toBe(3);
    expect(SOFT_CLOSE_CONFIDENCE_THRESHOLD).toBe(0.7);
    expect(plans.get("00000000-0000-4000-8000-0000000000a1")).toEqual({
      loopId: "00000000-0000-4000-8000-0000000000a1",
      excerpt: "finally submitted the passport renewal this morning btw",
      confidence: 0.86,
    });
    expect(classifier).toHaveBeenCalledWith({ title: "Renew passport", candidates: [evidence] });
  });

  it("keeps the normal nudge path on a negative classification or low-confidence positive", async () => {
    const retrieval = vi.fn(async () => [candidate()]);
    for (const classification of [
      { completed: false, confidence: 0.95 },
      { completed: true, confidence: 0.4 },
    ]) {
      const classifier: CompletionClassifier = async () => classification;
      const plans = await reconcileOverdueCommitments({
        profileId: "profile-a",
        loops: [makeLoop()],
        now: NOW,
        retrieval,
        classifier,
      });
      expect(plans.size).toBe(0);
    }
  });

  it("treats retrieval and classifier failures as not-completed instead of failing the sweep", async () => {
    const throwingRetrieval = vi.fn(async () => {
      throw new Error("search index down");
    });
    const unusedClassifier: CompletionClassifier = vi.fn(async () => ({ completed: true, confidence: 1 }));
    const retrievalFailurePlans = await reconcileOverdueCommitments({
      profileId: "profile-a",
      loops: [makeLoop()],
      now: NOW,
      retrieval: throwingRetrieval,
      classifier: unusedClassifier,
    });
    expect(retrievalFailurePlans.size).toBe(0);
    expect(unusedClassifier).not.toHaveBeenCalled();

    const throwingClassifier: CompletionClassifier = async () => {
      throw new Error("model down");
    };
    const classifierFailurePlans = await reconcileOverdueCommitments({
      profileId: "profile-a",
      loops: [makeLoop()],
      now: NOW,
      retrieval: vi.fn(async () => [candidate()]),
      classifier: throwingClassifier,
    });
    expect(classifierFailurePlans.size).toBe(0);
  });

  it("skips ineligible loops without spending a search or model call", async () => {
    const retrieval = vi.fn(async () => [candidate()]);
    const classifier: CompletionClassifier = vi.fn(async () => ({ completed: true, confidence: 1 }));
    const plans = await reconcileOverdueCommitments({
      profileId: "profile-a",
      loops: [
        makeLoop({ id: "00000000-0000-4000-8000-000000000002", dueAt: "2026-08-21T09:00:00.000Z" }),
        makeLoop({ id: "00000000-0000-4000-8000-000000000003", kind: "routine", cadence: { kind: "daily" } }),
        makeLoop({ id: "00000000-0000-4000-8000-000000000004", status: "done", closedAt: NOW }),
        makeLoop(),
      ],
      now: NOW,
      retrieval,
      classifier,
    });
    expect([...plans.keys()]).toEqual(["00000000-0000-4000-8000-0000000000a1"]);
    expect(retrieval).toHaveBeenCalledTimes(1);
    expect(classifier).toHaveBeenCalledTimes(1);
  });

  it("compacts evidence excerpts to eighty characters at a word boundary", () => {
    expect(excerptForSoftClose("  finally   submitted\nthe passport renewal  ")).toBe(
      "finally submitted the passport renewal",
    );
    const long = "I finally got around to finishing the whole thing yesterday after work and it feels great honestly";
    const excerpt = excerptForSoftClose(long);
    expect(excerpt.length).toBeLessThanOrEqual(80);
    expect(long.startsWith(excerpt.replace(/…$/, ""))).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("builds production seams like the small-model factories and degrades safely", async () => {
    const envKey = "OPENROUTER_" + "API_KEY";
    const previousKey = process.env[envKey];
    delete process.env[envKey];
    try {
      expect(() => createProductionCompletionClassifier()).toThrow(new RegExp(envKey));
      expect(() => createProductionCommitmentRetrieval()).toThrow(/SUPABASE_SERVICE_ROLE_KEY|SUPABASE_URL/);
    } finally {
      if (previousKey === undefined) delete process.env[envKey];
      else process.env[envKey] = previousKey;
    }
  });
});
