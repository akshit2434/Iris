import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { AppliedMemoryDocumentRevision, MemoryStore } from "@/server/memory/types";
import { assertMemoryProfileId, validateLogicalKey, validateMemoryUuid } from "@/server/memory/validation";

export type GovernedMemoryArchiveInput = {
  profileId: ProfileId;
  threadId: string;
  currentUserMessageId: string;
  agentRunId: string;
  toolCallId: string;
  logicalKey: string;
  expectedDocumentRevision: number;
  reason?: string | null;
};

export type GovernedMemoryArchiveResult =
  | { status: "applied"; logicalKey: string; revision: AppliedMemoryDocumentRevision }
  | { status: "not_found" | "stale" | "conflict"; logicalKey: string; reason: string };

export type MemoryArchiveService = {
  archive: (input: GovernedMemoryArchiveInput) => Promise<GovernedMemoryArchiveResult>;
};

export function createMemoryArchiveService(store: MemoryStore): MemoryArchiveService {
  return {
    async archive(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.threadId, "Thread ID");
      validateMemoryUuid(input.currentUserMessageId, "Current user message ID");
      validateMemoryUuid(input.agentRunId, "Agent run ID");
      if (!input.toolCallId.trim() || input.toolCallId.length > 200) throw new Error("Memory archive tool identity is invalid.");
      const logicalKey = validateLogicalKey(input.logicalKey);
      if (!Number.isSafeInteger(input.expectedDocumentRevision) || input.expectedDocumentRevision < 1) {
        return { status: "stale", logicalKey, reason: "Archive requires the current document revision." };
      }
      const sourceContext = await store.readMessageContext(input.profileId, input.currentUserMessageId, 1);
      if (!sourceContext || sourceContext.thread.id !== input.threadId || sourceContext.target.profileId !== input.profileId || sourceContext.target.role !== "user") {
        return { status: "conflict", logicalKey, reason: "The current user message is not owned by this profile/thread." };
      }
      const document = await store.getDocument(input.profileId, logicalKey, { includeArchived: true });
      if (!document) return { status: "not_found", logicalKey, reason: "That canonical memory is not currently active." };
      if (document.documentRevision !== input.expectedDocumentRevision) {
        return { status: "stale", logicalKey, reason: "The canonical document changed; reread it before archiving." };
      }
      try {
        const revision = await store.applyDocumentRevision({
          profileId: input.profileId,
          logicalKey,
          contentMarkdown: document.contentMarkdown,
          mutationKind: "archive",
          expectedDocumentRevision: input.expectedDocumentRevision,
          idempotencyKey: `memory-archive:${input.agentRunId}:${input.toolCallId}`,
          provenance: {
            sourceKind: "message",
            sourceThreadId: input.threadId,
            sourceMessageId: input.currentUserMessageId,
            sourceExcerpt: input.reason ?? null,
          },
        });
        return { status: "applied", logicalKey, revision };
      } catch (error) {
        if (/stale|already exists|idempotency/i.test(error instanceof Error ? error.message : "")) {
          return { status: "stale", logicalKey, reason: "The canonical document changed; reread it before archiving." };
        }
        throw new Error("Memory archive could not be applied.");
      }
    },
  };
}
