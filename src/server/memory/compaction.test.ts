import { afterEach, describe, expect, it, vi } from "vitest";
import { createInjectedThreadCompactor, processThreadCompactionJobs, shouldEnqueueThreadCompaction } from "@/server/memory/compaction";
import type { ThreadCompactionJob, ThreadCompactionStore } from "@/server/memory/types";

const job: ThreadCompactionJob = {
  id: "00000000-0000-4000-8000-000000000021", profileId: "profile-a", threadId: "00000000-0000-4000-8000-000000000011", sourceRunId: "00000000-0000-4000-8000-000000000012", status: "running", attempts: 1, idempotencyKey: "compact", expectedCompactedThroughMessageId: null, expectedContinuityRevision: 0, checkpointMessageId: "00000000-0000-4000-8000-000000000010", checkpointCreatedAt: "2026-08-18T00:00:00.000Z", recentTailMessages: 24, availableAt: "now", leaseExpiresAt: "later", lockedAt: "now", lockedBy: "worker", lastErrorCode: null, lastErrorMessage: null, createdAt: "now", updatedAt: "now", completedAt: null,
};

function store(overrides: Partial<ThreadCompactionStore> = {}): ThreadCompactionStore {
  return {
    enqueueCompactionJob: vi.fn(async () => job),
    claimCompactionJobs: vi.fn(async () => [job]),
    listCompactionMessages: vi.fn(async () => [{ messageId: "m", profileId: "profile-a" as const, threadId: job.threadId, role: "user" as const, content: "Decision", createdAt: "now" }]),
    readCompactionContext: vi.fn(async () => ({ continuitySummary: "Prior", pinnedNotes: ["Constraint"] })),
    applyCompactionCheckpoint: vi.fn(async () => "applied" as const),
    finishCompactionJob: vi.fn(async () => job),
    ...overrides,
  };
}

afterEach(() => { delete process.env.THREAD_COMPACTION_ENABLED; });

describe("thread compaction", () => {
  it("enqueues only after the configured high threshold", () => {
    expect(shouldEnqueueThreadCompaction({ messageCount: 79 })).toBe(false);
    expect(shouldEnqueueThreadCompaction({ messageCount: 80 })).toBe(true);
  });

  it("does no work while processing is disabled", async () => {
    const compactionStore = store();
    await expect(processThreadCompactionJobs({ store: compactionStore, compactor: createInjectedThreadCompactor(async () => ({ continuitySummary: "x", pinnedNotes: [] })) })).resolves.toMatchObject({ claimed: 0 });
    expect(compactionStore.claimCompactionJobs).not.toHaveBeenCalled();
  });

  it("keeps the raw ordered slice and applies a checkpoint through the injected store", async () => {
    process.env.THREAD_COMPACTION_ENABLED = "true";
    const compactionStore = store();
    const compactor = createInjectedThreadCompactor(async (input) => {
      expect(input.messages[0]?.content).toBe("Decision");
      expect(input.continuitySummary).toBe("Prior");
      return { continuitySummary: "Decision retained", pinnedNotes: ["Constraint"] };
    });
    await expect(processThreadCompactionJobs({ store: compactionStore, compactor, workerId: "worker" })).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(compactionStore.applyCompactionCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ summary: "Decision retained" }));
    expect(compactionStore.finishCompactionJob).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("records a stale checkpoint as a conflict", async () => {
    process.env.THREAD_COMPACTION_ENABLED = "true";
    const compactionStore = store({ applyCompactionCheckpoint: vi.fn(async () => "conflict" as const) });
    await expect(processThreadCompactionJobs({ store: compactionStore, compactor: createInjectedThreadCompactor(async () => ({ continuitySummary: "x", pinnedNotes: [] })) })).resolves.toMatchObject({ conflicts: 1 });
    expect(compactionStore.finishCompactionJob).toHaveBeenCalledWith(expect.objectContaining({ status: "conflict", errorCode: "STALE_CHECKPOINT" }));
  });
});
