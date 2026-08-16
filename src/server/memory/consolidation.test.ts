import { describe, expect, it, vi } from "vitest";
import { createInjectedMemoryConsolidator, isMeaningfulMemoryCandidate, processConsolidationJobs, shouldEnqueueConsolidation, validateConsolidationProposals } from "@/server/memory/consolidation";
import type { MemoryConsolidationJob, MemoryGovernanceStore, MemoryItem, MemoryStore } from "@/server/memory/types";

const job: MemoryConsolidationJob = { id: "00000000-0000-4000-8000-000000000030", profileId: "profile-a", threadId: "00000000-0000-4000-8000-000000000011", sourceRunId: "00000000-0000-4000-8000-000000000012", status: "running", sourceStartTokenTotal: 0, sourceTokenTotal: 1_500, attempts: 1, availableAt: "now", leaseExpiresAt: null, lockedAt: "now", lockedBy: "worker", lastErrorCode: null, lastErrorMessage: null, createdAt: "now", updatedAt: "now", completedAt: null };
const messages = [{ messageId: "00000000-0000-4000-8000-000000000010", profileId: "profile-a" as const, threadId: job.threadId, content: "I prefer concise answers." }];
const items: MemoryItem[] = [];

function memoryStore(): MemoryStore { return { listItems: vi.fn(async () => items), getItem: vi.fn(async () => null), getCurrentRevision: vi.fn(async () => 0), applyItemRevision: vi.fn(), searchMessages: vi.fn(async () => []), readMessageContext: vi.fn(async () => null), searchItems: vi.fn(async () => []) } as unknown as MemoryStore; }
function governanceStore(): MemoryGovernanceStore {
  const stored = { id: "00000000-0000-4000-8000-000000000031", profileId: "profile-a" as const, threadId: job.threadId, sourceRunId: job.sourceRunId, jobId: job.id, proposalIndex: 0, idempotencyKey: "key", canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", category: "preference" as const, valueScope: "single" as const, origin: "inferred" as const, confidence: 0.8, importance: 0.7, sensitivity: "normal" as const, expectedItemRevision: null, mutationKind: "create" as const, sourceMessageIds: [messages[0].messageId], rationale: null, status: "proposed" as const, reason: null, resultRevisionId: null, createdAt: "now", updatedAt: "now", appliedAt: null };
  return { claimConsolidationJobs: vi.fn(async () => [job]), listJobMessages: vi.fn(async () => messages), insertMutationProposal: vi.fn(async () => stored), applyMutationProposal: vi.fn(async () => ({ status: "applied" as const, proposalId: stored.id, itemId: "item", itemRevision: 1, profileGlobalRevision: 1, revisionId: "rev", sourceId: "source", reason: null })), finishConsolidationJob: vi.fn(async () => job), enqueueConsolidationJob: vi.fn(async () => job) };
}

describe("durable structured memory consolidation", () => {
  it("fast-lanes category-diverse first-person statements without domain keywords", () => {
    expect(isMeaningfulMemoryCandidate("Also I have a macbook m4 air and realme gt 7 just fyi")).toBe(true);
    expect(isMeaningfulMemoryCandidate("I always avoid peanuts when choosing food")).toBe(true);
    expect(isMeaningfulMemoryCandidate("My sister is helping with the launch this month")).toBe(true);
    expect(isMeaningfulMemoryCandidate("Our project has a strict Friday release constraint")).toBe(true);
    expect(isMeaningfulMemoryCandidate("Please remember that the quiet table works best for me")).toBe(true);
    expect(isMeaningfulMemoryCandidate("Hey")).toBe(false);
    expect(isMeaningfulMemoryCandidate("thanks, that was helpful")).toBe(false);
    expect(isMeaningfulMemoryCandidate("What food should I order tonight?")).toBe(false);
    expect(isMeaningfulMemoryCandidate("What devices do i have")).toBe(false);
    expect(isMeaningfulMemoryCandidate("Can u tell me a must have app for my devices")).toBe(false);
  });
  it("enqueues only after a successful run with a persisted assistant", () => {
    expect(shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted: true })).toBe(true);
    expect(shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 200 })).toBe(false);
    expect(shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 200, idleSignal: true })).toBe(true);
    expect(shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 1_200 })).toBe(true);
    expect(shouldEnqueueConsolidation({ runStatus: "completed", assistantPersisted: false })).toBe(false);
    expect(shouldEnqueueConsolidation({ runStatus: "failed", assistantPersisted: true })).toBe(false);
  });
  it("rejects foreign sources and duplicate canonical keys", () => {
    expect(() => validateConsolidationProposals({ job, messages, items }, [{ canonicalKey: "x", proposedContent: "x", expectedItemRevision: null, mutationKind: "create", sourceMessageIds: ["00000000-0000-4000-8000-000000000099"] }])).toThrow("foreign");
    expect(() => validateConsolidationProposals({ job, messages, items }, [{ canonicalKey: "x", proposedContent: "x", confidence: 0.8, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId] }, { canonicalKey: "x", proposedContent: "y", confidence: 0.8, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId] }])).toThrow("duplicate");
  });
  it("processes a bounded job with replay-safe proposal identity and no model/network call", async () => {
    const governance = governanceStore();
    const producer = vi.fn(async () => [{ canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", category: "preference", confidence: 0.8, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId], rationale: "Stable preference" }]);
    const result = await processConsolidationJobs({ governanceStore: governance, memoryStore: memoryStore(), consolidator: createInjectedMemoryConsolidator(producer), workerId: "worker" });
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(governance.insertMutationProposal).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.stringContaining(`consolidation:${job.sourceRunId}:0:`) }));
    expect(governance.applyMutationProposal).toHaveBeenCalledTimes(1);
  });
  it("claims the requested fast-lane job instead of an unrelated backlog item", async () => {
    const governance = governanceStore();
    governance.claimConsolidationJob = vi.fn(async () => job);
    const result = await processConsolidationJobs({
      governanceStore: governance,
      memoryStore: memoryStore(),
      consolidator: createInjectedMemoryConsolidator(async () => []),
      workerId: "worker",
      job: { id: job.id, profileId: job.profileId },
    });
    expect(result).toMatchObject({ claimed: 1, skipped: 1 });
    expect(governance.claimConsolidationJob).toHaveBeenCalledWith(job.profileId, job.id, "worker", 120);
    expect(governance.claimConsolidationJobs).not.toHaveBeenCalled();
  });
  it("does not persist proposals that match an active suppression", async () => {
    const governance = governanceStore();
    const store = memoryStore();
    store.isSuppressed = vi.fn(async () => true);
    const result = await processConsolidationJobs({
      governanceStore: governance,
      memoryStore: store,
      consolidator: createInjectedMemoryConsolidator(async () => [{ canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", confidence: 0.8, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId] }]),
      workerId: "worker",
    });
    expect(result).toMatchObject({ claimed: 1, skipped: 1, conflicts: 1 });
    expect(governance.insertMutationProposal).not.toHaveBeenCalled();
    expect(governance.applyMutationProposal).not.toHaveBeenCalled();
  });
  it("skips queued writes after saved memory is disabled", async () => {
    const governance = governanceStore();
    const producer = vi.fn(async () => [{ canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", category: "preference", confidence: 0.8, expectedItemRevision: null, mutationKind: "create" as const, sourceMessageIds: [messages[0].messageId] }]);
    const result = await processConsolidationJobs({
      governanceStore: governance,
      memoryStore: memoryStore(),
      consolidator: createInjectedMemoryConsolidator(producer),
      controlsReader: vi.fn(async () => ({ savedMemoryEnabled: false })),
      workerId: "worker",
    });
    expect(result).toMatchObject({ claimed: 1, skipped: 1, completed: 0 });
    expect(producer).not.toHaveBeenCalled();
    expect(governance.insertMutationProposal).not.toHaveBeenCalled();
    expect(governance.finishConsolidationJob).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped", errorCode: "SAVED_MEMORY_DISABLED" }));
  });
  it("marks a job skipped when no source messages exist", async () => {
    const governance = governanceStore(); vi.mocked(governance.listJobMessages).mockResolvedValue([]);
    const result = await processConsolidationJobs({ governanceStore: governance, memoryStore: memoryStore(), consolidator: { propose: vi.fn() }, workerId: "worker" });
    expect(result).toMatchObject({ claimed: 1, skipped: 1 }); expect(governance.finishConsolidationJob).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
  });
  it("keeps failed processing retryable and bounds the claim", async () => {
    const governance = governanceStore();
    const result = await processConsolidationJobs({ governanceStore: governance, memoryStore: memoryStore(), consolidator: { propose: vi.fn(async () => { throw new Error("temporary provider failure"); }) }, workerId: "worker", limit: 3, leaseSeconds: 45 });
    expect(result.failed).toBe(1); expect(governance.claimConsolidationJobs).toHaveBeenCalledWith("worker", 3, 45); expect(governance.finishConsolidationJob).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", retry: true, errorCode: "CONSOLIDATION_FAILED" }));
  });

  it("rejects weak or unsafe automatic candidates instead of persisting them", () => {
    expect(() => validateConsolidationProposals({ job, messages, items }, [{ canonicalKey: "profile.secret", proposedContent: "The user's password: hunter2", confidence: 0.99, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId] }])).toThrow("Credentials");
    expect(() => validateConsolidationProposals({ job, messages, items }, [{ canonicalKey: "profile.weak", proposedContent: "The user might prefer blue.", confidence: 0.2, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId] }])).toThrow("stronger evidence");
  });

  it("preserves every source message for one derived candidate", () => {
    const secondMessage = { ...messages[0], messageId: "00000000-0000-4000-8000-000000000013", content: "I also prefer concise answers." };
    const proposals = validateConsolidationProposals({ job, messages: [messages[0], secondMessage], items }, [{ canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", confidence: 0.9, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [messages[0].messageId, secondMessage.messageId] }]);
    expect(proposals[0]?.sourceMessageIds).toEqual([messages[0].messageId, secondMessage.messageId]);
  });

  it("does not silently choose a winner for an ambiguous conflict", () => {
    const existing: MemoryItem = { id: "00000000-0000-4000-8000-000000000099", profileId: "profile-a", canonicalKey: "profile.communication", content: "The user prefers detailed answers.", itemRevision: 2, category: "preference", valueScope: "single", origin: "explicit", confidence: 1, importance: 0.8, sensitivity: "normal", status: "active", validFrom: null, validUntil: null, lastConfirmedAt: null, supersededByItemId: null, createdAt: "now", updatedAt: "now", archivedAt: null, deletedAt: null };
    expect(() => validateConsolidationProposals({ job, messages, items: [existing] }, [{ canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", confidence: 0.9, expectedItemRevision: 2, mutationKind: "update", sourceMessageIds: [messages[0].messageId] }])).toThrow("ambiguous");
  });
});
