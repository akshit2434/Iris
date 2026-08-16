import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { AppliedMemoryItemRevision, MemoryStore } from "@/server/memory/types";
import { assertMemoryProfileId, validateCanonicalKey, validateMemoryUuid } from "@/server/memory/validation";

export type GovernedMemoryArchiveInput = {
  profileId: ProfileId;
  threadId: string;
  currentUserMessageId: string;
  agentRunId: string;
  toolCallId: string;
  canonicalKey: string;
  expectedItemRevision: number;
  reason?: string | null;
};
export type GovernedMemoryArchiveResult =
  | { status: "applied"; canonicalKey: string; revision: AppliedMemoryItemRevision }
  | { status: "not_found" | "stale" | "conflict"; canonicalKey: string; reason: string };
export type MemoryArchiveService = { archive: (input: GovernedMemoryArchiveInput) => Promise<GovernedMemoryArchiveResult> };

export function createMemoryArchiveService(store: MemoryStore): MemoryArchiveService {
  return {
    async archive(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.threadId, "Thread ID");
      validateMemoryUuid(input.currentUserMessageId, "Current user message ID");
      validateMemoryUuid(input.agentRunId, "Agent run ID");
      if (!input.toolCallId.trim() || input.toolCallId.length > 200) throw new Error("Memory archive tool identity is invalid.");
      const canonicalKey = validateCanonicalKey(input.canonicalKey);
      if (!Number.isSafeInteger(input.expectedItemRevision) || input.expectedItemRevision < 1) return { status: "stale", canonicalKey, reason: "Archive requires the current memory item revision." };
      const sourceContext = await store.readMessageContext(input.profileId, input.currentUserMessageId, 1);
      if (!sourceContext || sourceContext.thread.id !== input.threadId || sourceContext.target.profileId !== input.profileId || sourceContext.target.role !== "user") return { status: "conflict", canonicalKey, reason: "The current user message is not owned by this profile/thread." };
      const item = await store.getItem(input.profileId, canonicalKey, { includeArchived: true });
      if (!item || item.status !== "active") return { status: "not_found", canonicalKey, reason: "That memory item is not currently active." };
      if (item.itemRevision !== input.expectedItemRevision) return { status: "stale", canonicalKey, reason: "The memory item changed; reread it before archiving." };
      try {
        const revision = await store.applyItemRevision({
          profileId: input.profileId, canonicalKey, content: item.content, category: item.category, valueScope: item.valueScope, origin: item.origin,
          confidence: item.confidence, importance: item.importance, sensitivity: item.sensitivity, status: "archived", mutationKind: "archive",
          expectedItemRevision: input.expectedItemRevision, idempotencyKey: `memory-archive:${input.agentRunId}:${input.toolCallId}`,
          provenance: {
            sourceKind: "message",
            sourceThreadId: input.threadId,
            sourceMessageId: input.currentUserMessageId,
            sourceExcerpt: input.reason ?? null,
            relation: "supersedes",
            metadata: { explicit: true, action: "forget" },
          },
        });
        if (store.createSuppression) await store.createSuppression({ profileId: input.profileId, canonicalKey, contentHash: revision.contentHash, itemId: revision.itemId, reason: input.reason });
        return { status: "applied", canonicalKey, revision };
      } catch (error) {
        if (/stale|already exists|idempotency/i.test(error instanceof Error ? error.message : "")) return { status: "stale", canonicalKey, reason: "The memory item changed; reread it before archiving." };
        throw new Error("Memory archive could not be applied.");
      }
    },
  };
}
