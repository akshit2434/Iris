import { describe, expect, it, vi } from "vitest";
import {
  applyReferenceHistoryConstraints,
  createInjectedReferenceHistorySynthesizer,
  formatReferenceHistoryPrompt,
  hashReferenceHistoryInput,
  processReferenceHistoryJobs,
  referenceHistoryPromptIsFresh,
  renderReferenceHistoryText,
  shouldQueueReferenceHistory,
  validateReferenceHistoryDocument,
} from "@/server/memory/reference-history";
import type {
  MemoryItem,
  MemoryStore,
  ReferenceHistoryDocument,
  ReferenceHistoryJob,
  ReferenceHistoryMessage,
  ReferenceHistorySnapshot,
  ReferenceHistoryStore,
} from "@/server/memory/types";

const ids = {
  threadA: "00000000-0000-4000-8000-000000000001",
  threadB: "00000000-0000-4000-8000-000000000002",
  run: "00000000-0000-4000-8000-000000000003",
  messageA: "00000000-0000-4000-8000-000000000004",
  messageB: "00000000-0000-4000-8000-000000000005",
  messageC: "00000000-0000-4000-8000-000000000006",
  snapshot: "00000000-0000-4000-8000-000000000007",
  job: "00000000-0000-4000-8000-000000000008",
};

const message = (input: Partial<ReferenceHistoryMessage> & Pick<ReferenceHistoryMessage, "messageId" | "threadId" | "content">): ReferenceHistoryMessage => ({
  profileId: "profile-a",
  role: "user",
  createdAt: "2026-08-16T10:00:00.000Z",
  estimatedTokens: 50,
  tokenStart: 0,
  tokenEnd: 50,
  ...input,
});

const emptyDocument = (): ReferenceHistoryDocument => ({
  version: "iris-reference-history-v1",
  ongoingWork: [],
  recurringPreferences: [],
  relationshipsContext: [],
  recentChanges: [],
  boundedPatterns: [],
  renderedText: "",
});

const job = (overrides: Partial<ReferenceHistoryJob> = {}): ReferenceHistoryJob => ({
  id: ids.job,
  profileId: "profile-a",
  sourceRunId: ids.run,
  status: "running",
  attempts: 1,
  idempotencyKey: "run:100:incremental",
  expectedSnapshotId: null,
  expectedSnapshotRevision: 0,
  sourceStartTokenWatermark: 0,
  sourceEndTokenWatermark: 100,
  rebuildFromRaw: false,
  idleSignal: false,
  model: "openai/test-model",
  synthesizerVersion: "iris-reference-history-v1",
  availableAt: "now",
  leaseExpiresAt: null,
  lockedAt: "now",
  lockedBy: "worker",
  lastErrorCode: null,
  lastErrorMessage: null,
  createdAt: "now",
  updatedAt: "now",
  completedAt: null,
  ...overrides,
});

function memoryItem(canonicalKey: string, content: string, itemRevision = 1): MemoryItem {
  return {
    id: ids.snapshot,
    profileId: "profile-a",
    canonicalKey,
    content,
    itemRevision,
    category: "preference",
    valueScope: "single",
    origin: "explicit",
    confidence: 1,
    importance: 0.8,
    sensitivity: "normal",
    status: "active",
    validFrom: null,
    validUntil: null,
    lastConfirmedAt: null,
    supersededByItemId: null,
    createdAt: "now",
    updatedAt: "now",
    archivedAt: null,
    deletedAt: null,
  };
}

function memoryStore(items: MemoryItem[] = []): MemoryStore {
  return {
    listItems: vi.fn(async () => items),
    getItem: vi.fn(async () => null),
    getCurrentRevision: vi.fn(async () => items.length),
    applyItemRevision: vi.fn(),
    searchMessages: vi.fn(async () => []),
    readMessageContext: vi.fn(async () => null),
    searchItems: vi.fn(async () => []),
    listActiveSuppressions: vi.fn(async () => []),
  } as unknown as MemoryStore;
}

function referenceStore(input: {
  jobs?: ReferenceHistoryJob[];
  messages?: ReferenceHistoryMessage[];
  latest?: ReferenceHistorySnapshot | null;
  controls?: { referenceHistoryEnabled: boolean };
  apply?: ReferenceHistoryStore["applyReferenceHistorySnapshot"];
}) {
  const jobs = input.jobs ?? [job()];
  const latest = input.latest ?? null;
  const applied: unknown[] = [];
  const store: ReferenceHistoryStore = {
    getControls: vi.fn(async () => ({ profileId: "profile-a" as const, savedMemoryEnabled: true, referenceHistoryEnabled: input.controls?.referenceHistoryEnabled ?? true, updatedAt: "now" })),
    getLatestSnapshot: vi.fn(async () => latest),
    listSourceMessages: vi.fn(async () => input.messages ?? []),
    claimReferenceHistoryJobs: vi.fn(async () => jobs),
    applyReferenceHistorySnapshot: input.apply ?? vi.fn(async (value) => { applied.push(value); return "applied" as const; }),
    finishReferenceHistoryJob: vi.fn(async (value) => ({ ...jobs[0], status: value.status, lastErrorCode: value.errorCode ?? null, lastErrorMessage: value.errorMessage ?? null })),
    enqueueReferenceHistoryJob: vi.fn(async () => null),
  };
  return { store, applied };
}

describe("reference-history synthesis", () => {
  it("uses evidence from multiple chats and renders a concise model view", async () => {
    const messages = [
      message({ messageId: ids.messageA, threadId: ids.threadA, content: "I am preparing the T1 exam." }),
      message({ messageId: ids.messageB, threadId: ids.threadB, content: "I am still prioritising T1 this week." }),
    ];
    const producer = vi.fn(async () => ({
      ongoingWork: [{ text: "T1 preparation is currently a priority.", confidence: 0.9, temporalQualifier: "currently", sourceMessageIds: [ids.messageA, ids.messageB], memoryKeys: [] }],
      recurringPreferences: [], relationshipsContext: [], recentChanges: [], boundedPatterns: [],
    }));
    const { store, applied } = referenceStore({ messages });
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer: createInjectedReferenceHistorySynthesizer(producer), workerId: "worker" });
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(producer).toHaveBeenCalledWith(expect.objectContaining({ messages }));
    expect(applied[0]).toMatchObject({ snapshot: { sourceRanges: [{ threadId: ids.threadA }, { threadId: ids.threadB }], coveredTokenWatermark: 100 } });
    expect((applied[0] as { snapshot: { renderedText: string } }).snapshot.renderedText).toContain("T1 preparation");
  });

  it("refreshes incrementally from the previous validated snapshot", async () => {
    const previous: ReferenceHistorySnapshot = {
      id: ids.snapshot,
      profileId: "profile-a",
      revision: 1,
      status: "active",
      document: { ...emptyDocument(), ongoingWork: [{ text: "Old project", confidence: 0.8, temporalQualifier: "last month", sourceMessageIds: [ids.messageA], memoryKeys: [] }], renderedText: "## Ongoing work\n- Old project (last month)" },
      renderedText: "## Ongoing work\n- Old project (last month)",
      sourceRanges: [],
      coveredTokenWatermark: 50,
      coveredThroughAt: "2026-08-01T00:00:00.000Z",
      sourceHash: "old-hash",
      memoryRevision: 0,
      model: "openai/test-model",
      synthesizerVersion: "iris-reference-history-v1",
      previousSnapshotId: null,
      createdAt: "now",
    };
    const nextJob = job({ expectedSnapshotId: ids.snapshot, expectedSnapshotRevision: 1, sourceStartTokenWatermark: 50, sourceEndTokenWatermark: 100 });
    const messages = [message({ messageId: ids.messageB, threadId: ids.threadB, content: "The project is now paused.", tokenStart: 50, tokenEnd: 100 })];
    let receivedPrevious: ReferenceHistorySnapshot | null = null;
    const synthesizer = createInjectedReferenceHistorySynthesizer(async (input) => {
      receivedPrevious = input.previousSnapshot;
      return { ...emptyDocument(), recentChanges: [{ text: "The project is now paused.", confidence: 0.95, temporalQualifier: "now", sourceMessageIds: [ids.messageB], memoryKeys: [] }] };
    });
    const { store } = referenceStore({ jobs: [nextJob], messages, latest: previous });
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer, workerId: "worker" });
    expect(result.completed).toBe(1);
    expect(receivedPrevious).toEqual(previous);
  });

  it("preserves uncertainty and drops unsafe speculative claims", () => {
    const source = [message({ messageId: ids.messageA, threadId: ids.threadA, content: "Evidence" })];
    const document = validateReferenceHistoryDocument({
      ongoingWork: [{ text: "Maybe I prefer blue.", confidence: 0.4, temporalQualifier: "uncertain", sourceMessageIds: [ids.messageA], memoryKeys: [] }],
      recurringPreferences: [{ text: "The user's password is hunter2", confidence: 1, sourceMessageIds: [ids.messageA], memoryKeys: [] }],
      relationshipsContext: [{ text: "The user might have ADHD.", confidence: 0.8, sourceMessageIds: [ids.messageA], memoryKeys: [] }],
      recentChanges: [], boundedPatterns: [],
    }, source);
    expect(document.ongoingWork[0]).toMatchObject({ temporalQualifier: "uncertain", confidence: 0.4 });
    expect(document.recurringPreferences).toEqual([]);
    expect(document.relationshipsContext).toEqual([]);
  });

  it("applies forgotten-memory suppressions as a hard read-time constraint", () => {
    const document: ReferenceHistoryDocument = {
      version: "iris-reference-history-v1",
      ongoingWork: [{ text: "User is working on Project X.", confidence: 0.9, temporalQualifier: null, sourceMessageIds: [ids.messageA], memoryKeys: ["project.current"] }],
      recurringPreferences: [], relationshipsContext: [], recentChanges: [], boundedPatterns: [], renderedText: "old",
    };
    const constrained = applyReferenceHistoryConstraints(document, {
      savedItems: [],
      suppressions: [{ id: ids.snapshot, profileId: "profile-a", canonicalKey: "project.current", contentHash: null, itemId: null, reason: "forgotten", createdAt: "now", liftedAt: null }],
    });
    expect(constrained.ongoingWork).toEqual([]);
    expect(constrained.renderedText).toBe("");
  });

  it("does not inject disabled or stale history", () => {
    const snapshot = { memoryRevision: 2, status: "active" as const } as ReferenceHistorySnapshot;
    expect(referenceHistoryPromptIsFresh(snapshot, 3)).toBe(false);
    expect(referenceHistoryPromptIsFresh({ ...snapshot, synthesizerVersion: "old-version" } as ReferenceHistorySnapshot, 2)).toBe(false);
    expect(formatReferenceHistoryPrompt({ ...snapshot, document: { ...emptyDocument(), renderedText: "hidden" }, renderedText: "hidden", revision: 1, sourceHash: "h" } as ReferenceHistorySnapshot)).toBe("");
  });

  it("deduplicates equivalent work and supports deterministic rebuild hashes", async () => {
    const messages = [message({ messageId: ids.messageA, threadId: ids.threadA, content: "Stable evidence" })];
    const sourceHash = hashReferenceHistoryInput({ profileId: "profile-a", messages, previousSnapshot: null, savedItems: [], suppressions: [], synthesizerVersion: "iris-reference-history-v1" });
    expect(sourceHash).toBe(hashReferenceHistoryInput({ profileId: "profile-a", messages, previousSnapshot: null, savedItems: [], suppressions: [], synthesizerVersion: "iris-reference-history-v1" }));
    const latest: ReferenceHistorySnapshot = { id: ids.snapshot, profileId: "profile-a", revision: 1, status: "active", document: emptyDocument(), renderedText: "", sourceRanges: [], coveredTokenWatermark: 100, coveredThroughAt: null, sourceHash, memoryRevision: 0, model: "openai/test-model", synthesizerVersion: "iris-reference-history-v1", previousSnapshotId: null, createdAt: "now" };
    const { store } = referenceStore({ messages, latest, jobs: [job({ expectedSnapshotId: ids.snapshot, expectedSnapshotRevision: 1 })] });
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer: { synthesize: vi.fn() }, workerId: "worker" });
    expect(result.skipped).toBe(1);
    expect(store.finishReferenceHistoryJob).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped", errorCode: "REFERENCE_HISTORY_ALREADY_CURRENT" }));
  });

  it("skips synthesis when the profile disabled cross-chat reference history", async () => {
    const { store } = referenceStore({ messages: [message({ messageId: ids.messageA, threadId: ids.threadA, content: "evidence" })], controls: { referenceHistoryEnabled: false } });
    const synthesizer = { synthesize: vi.fn() };
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer, workerId: "worker" });
    expect(result.skipped).toBe(1);
    expect(synthesizer.synthesize).not.toHaveBeenCalled();
  });

  it("uses token watermarks, not message counts, for enqueue decisions", () => {
    expect(shouldQueueReferenceHistory({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 2_399, lastProcessedTokenWatermark: 0 })).toBe(false);
    expect(shouldQueueReferenceHistory({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 2_400, lastProcessedTokenWatermark: 0 })).toBe(true);
    expect(shouldQueueReferenceHistory({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 10, lastProcessedTokenWatermark: 0, idleSignal: true })).toBe(true);
    expect(shouldQueueReferenceHistory({ runStatus: "completed", assistantPersisted: true, sourceTokenTotal: 10, lastProcessedTokenWatermark: 10, idleSignal: true })).toBe(false);
  });

  it("keeps the previous snapshot when synthesis fails and schedules a retry", async () => {
    const { store } = referenceStore({ messages: [message({ messageId: ids.messageA, threadId: ids.threadA, content: "evidence" })] });
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer: { synthesize: vi.fn(async () => { throw new Error("provider unavailable"); }) }, workerId: "worker" });
    expect(result.failed).toBe(1);
    expect(store.finishReferenceHistoryJob).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", retry: true, errorCode: "REFERENCE_HISTORY_FAILED" }));
    expect(store.applyReferenceHistorySnapshot).not.toHaveBeenCalled();
  });

  it("routes optional saved-memory candidates through the existing validator", async () => {
    const source = message({ messageId: ids.messageA, threadId: ids.threadA, content: "I prefer concise answers." });
    const { store } = referenceStore({ messages: [source] });
    const candidates: unknown[] = [];
    const result = await processReferenceHistoryJobs({
      store,
      memoryStore: memoryStore(),
      synthesizer: createInjectedReferenceHistorySynthesizer(async () => ({
        document: emptyDocument(),
        memoryCandidates: [
          { canonicalKey: "profile.communication", proposedContent: "The user prefers concise answers.", category: "preference", confidence: 0.9, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [ids.messageA] },
          { canonicalKey: "profile.secret", proposedContent: "The user's password is hunter2", confidence: 1, expectedItemRevision: null, mutationKind: "create", sourceMessageIds: [ids.messageA] },
        ],
      })),
      onValidatedMemoryCandidates: vi.fn(async (input) => { candidates.push(...input.candidates); }),
      workerId: "worker",
    });
    expect(result.completed).toBe(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ canonicalKey: "profile.communication" });
  });

  it("does not cross profile boundaries", async () => {
    const foreign = message({ messageId: ids.messageA, threadId: ids.threadA, content: "foreign", profileId: "profile-b" });
    const { store } = referenceStore({ messages: [foreign] });
    const result = await processReferenceHistoryJobs({ store, memoryStore: memoryStore(), synthesizer: { synthesize: vi.fn() }, workerId: "worker" });
    expect(result.failed).toBe(1);
    expect(store.finishReferenceHistoryJob).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorCode: "REFERENCE_HISTORY_FAILED" }));
  });

  it("renders only concise natural text for the model", () => {
    const text = renderReferenceHistoryText({
      ongoingWork: [{ text: "T1 preparation", confidence: 0.9, temporalQualifier: "currently", sourceMessageIds: [ids.messageA], memoryKeys: [] }],
      recurringPreferences: [], relationshipsContext: [], recentChanges: [], boundedPatterns: [],
    });
    expect(text).toBe("## Ongoing work\n- T1 preparation (currently)");
  });
});
