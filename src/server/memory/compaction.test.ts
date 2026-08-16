import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createInjectedThreadContinuitySummarizer,
  processThreadContinuityJobs,
  shouldCompactSynchronously,
  shouldQueueContinuity,
  validateContinuitySummary,
} from "@/server/memory/compaction";
import type { ThreadContinuityJob, ThreadContinuityStore } from "@/server/memory/types";

const ids = {
  job: "00000000-0000-4000-8000-000000000021",
  thread: "00000000-0000-4000-8000-000000000011",
  run: "00000000-0000-4000-8000-000000000012",
  first: "00000000-0000-4000-8000-000000000010",
  end: "00000000-0000-4000-8000-000000000013",
};

const job: ThreadContinuityJob = {
  id: ids.job,
  profileId: "profile-a",
  threadId: ids.thread,
  sourceRunId: ids.run,
  status: "running",
  attempts: 1,
  idempotencyKey: "thread-continuity:test",
  expectedCheckpointId: null,
  expectedContinuityRevision: 0,
  sourceStartMessageId: ids.first,
  sourceEndMessageId: ids.end,
  sourceStartOrdinal: 0,
  sourceEndOrdinal: 2,
  sourceEstimatedTokens: 40,
  projectedInputTokens: 49_000,
  safeInputBudgetTokens: 65_000,
  inputHash: "a".repeat(64),
  model: "openai/test-model",
  tokenizerProvider: "openrouter",
  tokenizerVersion: "iris-conservative-v1",
  rebuildFromRaw: false,
  availableAt: "now",
  leaseExpiresAt: "later",
  lockedAt: "now",
  lockedBy: "worker",
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "now",
  updatedAt: "now",
  completedAt: null,
};

const messages = [
  { messageId: ids.first, profileId: "profile-a" as const, threadId: ids.thread, role: "user" as const, content: "We decided to ship the parser first.", createdAt: "2026-08-18T00:00:00.000Z", ordinal: 0, estimatedTokens: 20, isComplete: true },
  { messageId: "00000000-0000-4000-8000-000000000014", profileId: "profile-a" as const, threadId: ids.thread, role: "assistant" as const, content: "Decision recorded.", createdAt: "2026-08-18T00:01:00.000Z", ordinal: 1, estimatedTokens: 10, isComplete: true },
  { messageId: ids.end, profileId: "profile-a" as const, threadId: ids.thread, role: "tool" as const, content: "Build passed.", createdAt: "2026-08-18T00:02:00.000Z", ordinal: 2, estimatedTokens: 10, isComplete: true },
];

function store(overrides: Partial<ThreadContinuityStore> = {}): ThreadContinuityStore {
  return {
    enqueueContinuityJob: vi.fn(async () => job),
    claimContinuityJobs: vi.fn(async () => [job]),
    listContinuityMessages: vi.fn(async () => messages),
    readLatestContinuityCheckpoint: vi.fn(async () => null),
    applyContinuityCheckpoint: vi.fn(async () => "applied" as const),
    invalidateContinuityCheckpoint: vi.fn(async () => undefined),
    finishContinuityJob: vi.fn(async () => job),
    ...overrides,
  };
}

afterEach(() => { delete process.env.MEMORY_CONTINUITY_ENABLED; });

describe("token-triggered continuity", () => {
  it("queues only at the 75% serialized-input threshold with an eligible source span", () => {
    expect(shouldQueueContinuity({ projectedInputTokens: 48_749, safeInputBudgetTokens: 65_000, eligibleSourceTokens: 100, sourceEndMessageId: ids.end })).toBe(false);
    expect(shouldQueueContinuity({ projectedInputTokens: 48_750, safeInputBudgetTokens: 65_000, eligibleSourceTokens: 100, sourceEndMessageId: ids.end })).toBe(true);
    expect(shouldQueueContinuity({ projectedInputTokens: 65_000, safeInputBudgetTokens: 65_000, eligibleSourceTokens: 0, sourceEndMessageId: ids.end })).toBe(false);
    expect(shouldCompactSynchronously({ projectedInputTokens: 65_001, safeInputBudgetTokens: 65_000, eligibleSourceTokens: 100, sourceEndMessageId: ids.end })).toBe(true);
  });

  it("keeps workers disabled without touching the queue or model", async () => {
    const continuityStore = store();
    const summarizer = { summarize: vi.fn() };
    await expect(processThreadContinuityJobs({ store: continuityStore, summarizer })).resolves.toMatchObject({ claimed: 0 });
    expect(continuityStore.claimContinuityJobs).not.toHaveBeenCalled();
    expect(summarizer.summarize).not.toHaveBeenCalled();
  });

  it("writes structured source-linked continuity through an injected summarizer", async () => {
    process.env.MEMORY_CONTINUITY_ENABLED = "true";
    const continuityStore = store();
    const summarizer = createInjectedThreadContinuitySummarizer(async (input) => {
      expect(input.previousCheckpoint).toBeNull();
      expect(input.messages.map((message) => message.messageId)).toEqual(messages.map((message) => message.messageId));
      return {
        threadGoal: "Ship parser",
        currentState: "Build passed",
        decisions: ["Ship parser first"],
        constraints: ["Keep raw history"],
        commitments: [],
        openQuestions: [],
        uncertainties: [],
        corrections: [],
        importantToolResults: [{ label: "Build", result: "Passed", sourceMessageIds: [ids.end] }],
        renderedText: "## Goal\nShip parser",
      };
    });
    await expect(processThreadContinuityJobs({ store: continuityStore, summarizer, workerId: "worker" })).resolves.toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(continuityStore.applyContinuityCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      expectedCheckpointId: null,
      checkpoint: expect.objectContaining({
        coveredThroughMessageId: ids.end,
        sourceEstimatedTokens: 40,
        document: expect.objectContaining({ version: "iris-continuity-document-v1", source: expect.objectContaining({ messageIds: messages.map((message) => message.messageId) }) }),
      }),
    }));
    expect(continuityStore.finishContinuityJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("rejects foreign tool provenance and preserves retryability on failure", async () => {
    expect(() => validateContinuitySummary({ importantToolResults: [{ label: "x", result: "y", sourceMessageIds: ["foreign"] }] }, messages)).toThrow("foreign");
    process.env.MEMORY_CONTINUITY_ENABLED = "true";
    const continuityStore = store();
    const result = await processThreadContinuityJobs({ store: continuityStore, summarizer: { summarize: vi.fn(async () => { throw new Error("provider unavailable"); }) }, workerId: "worker" });
    expect(result).toMatchObject({ failed: 1 });
    expect(continuityStore.finishContinuityJob).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", retry: true, errorCode: "CONTINUITY_FAILED" }));
  });

  it("does not incrementally summarize over a newer checkpoint and supports raw rebuilds", async () => {
    process.env.MEMORY_CONTINUITY_ENABLED = "true";
    const newer = { id: "00000000-0000-4000-8000-000000000099" } as never;
    const continuityStore = store({ readLatestContinuityCheckpoint: vi.fn(async () => newer) });
    const result = await processThreadContinuityJobs({ store: continuityStore, summarizer: { summarize: vi.fn() }, workerId: "worker" });
    expect(result.conflicts).toBe(1);
    expect(continuityStore.applyContinuityCheckpoint).not.toHaveBeenCalled();

    const rebuildJob = { ...job, id: "00000000-0000-4000-8000-000000000022", rebuildFromRaw: true };
    const rebuildStore = store({ claimContinuityJobs: vi.fn(async () => [rebuildJob]) });
    const summarizer = createInjectedThreadContinuitySummarizer(async (input) => {
      expect(input.rebuildFromRaw).toBe(true);
      expect(input.previousCheckpoint).toBeNull();
      return { threadGoal: null, currentState: null, decisions: [], constraints: [], commitments: [], openQuestions: [], uncertainties: [], corrections: [], importantToolResults: [], renderedText: "rebuild" };
    });
    await expect(processThreadContinuityJobs({ store: rebuildStore, summarizer, workerId: "worker" })).resolves.toMatchObject({ completed: 1 });
  });
});
