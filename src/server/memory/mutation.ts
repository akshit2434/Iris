import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { AppliedMemoryDocumentRevision, MemoryStore } from "@/server/memory/types";
import { assertMemoryProfileId, validateCanonicalMarkdown, validateLogicalKey, validateMemoryUuid } from "@/server/memory/validation";

const MAX_GOVERNED_MARKDOWN_LENGTH = 20_000;

export type GovernedMemoryPatchInput = {
  profileId: ProfileId;
  threadId: string;
  currentUserMessageId: string;
  agentRunId: string;
  toolCallId: string;
  logicalKey: string;
  contentMarkdown: string;
  expectedDocumentRevision: number | null;
  mutationKind: "create" | "update" | "merge";
};

export type GovernedMemoryPatchResult =
  | { status: "applied"; logicalKey: string; revision: AppliedMemoryDocumentRevision }
  | { status: "conflict" | "stale"; logicalKey: string; reason: string; candidates: string[] };

export type MemoryMutationService = {
  apply: (input: GovernedMemoryPatchInput) => Promise<GovernedMemoryPatchResult>;
};

function safeCandidates(documents: readonly { logicalKey: string }[]) {
  return documents.slice(0, 5).map((document) => document.logicalKey);
}

function relatedDocuments(documents: Awaited<ReturnType<MemoryStore["listDocuments"]>>, logicalKey: string, contentMarkdown: string) {
  const terms = new Set(`${logicalKey} ${contentMarkdown}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
  return documents.filter((document) => {
    if (document.logicalKey === logicalKey) return true;
    const candidateTerms = document.logicalKey.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4);
    return candidateTerms.some((term) => terms.has(term));
  });
}

export function createMemoryMutationService(store: MemoryStore): MemoryMutationService {
  return {
    async apply(input) {
      assertMemoryProfileId(input.profileId);
      validateMemoryUuid(input.threadId, "Thread ID");
      validateMemoryUuid(input.currentUserMessageId, "Current user message ID");
      validateMemoryUuid(input.agentRunId, "Agent run ID");
      if (!input.toolCallId.trim() || input.toolCallId.length > 200) throw new Error("Memory mutation tool identity is invalid.");
      const logicalKey = validateLogicalKey(input.logicalKey);
      const contentMarkdown = validateCanonicalMarkdown(input.contentMarkdown.trim());
      if (contentMarkdown.length > MAX_GOVERNED_MARKDOWN_LENGTH) {
        return { status: "conflict", logicalKey, reason: "Memory patches are limited to 20,000 characters.", candidates: [] };
      }
      if (input.mutationKind === "create" && input.expectedDocumentRevision !== null) {
        return { status: "stale", logicalKey, reason: "Create patches must use a null expected revision.", candidates: [] };
      }
      if (input.mutationKind !== "create" && (input.expectedDocumentRevision === null || !Number.isSafeInteger(input.expectedDocumentRevision) || input.expectedDocumentRevision < 0)) {
        return { status: "stale", logicalKey, reason: "Update and merge patches require the current expected revision.", candidates: [] };
      }

      const sourceContext = await store.readMessageContext(input.profileId, input.currentUserMessageId, 1);
      if (!sourceContext || sourceContext.thread.id !== input.threadId || sourceContext.target.profileId !== input.profileId || sourceContext.target.role !== "user") {
        return { status: "conflict", logicalKey, reason: "The current user message is not owned by this profile/thread.", candidates: [] };
      }
      const documents = await store.listDocuments(input.profileId);
      const current = documents.find((document) => document.logicalKey === logicalKey);
      const related = relatedDocuments(documents, logicalKey, contentMarkdown);
      if (input.mutationKind === "create" && related.length > 0) {
        return {
          status: "conflict",
          logicalKey,
          reason: current ? "A canonical document with this key already exists." : "A related canonical document may already contain this fact.",
          candidates: safeCandidates(related),
        };
      }
      if (input.mutationKind !== "create" && !current) {
        return { status: "stale", logicalKey, reason: "The canonical document no longer exists.", candidates: [] };
      }
      if (current && input.expectedDocumentRevision !== null && current.documentRevision !== input.expectedDocumentRevision) {
        return { status: "stale", logicalKey, reason: "The canonical document changed; reread it before updating.", candidates: [logicalKey] };
      }

      try {
        const revision = await store.applyDocumentRevision({
          profileId: input.profileId,
          logicalKey,
          contentMarkdown,
          mutationKind: input.mutationKind,
          expectedDocumentRevision: input.expectedDocumentRevision,
          idempotencyKey: `memory-patch:${input.agentRunId}:${input.toolCallId}`,
          provenance: {
            sourceKind: "message",
            sourceThreadId: input.threadId,
            sourceMessageId: input.currentUserMessageId,
          },
        });
        return { status: "applied", logicalKey, revision };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/stale|already exists|idempotency/i.test(message)) {
          return { status: "stale", logicalKey, reason: "The canonical document changed; reread it before updating.", candidates: current ? [logicalKey] : [] };
        }
        throw new Error("Memory mutation could not be applied.");
      }
    },
  };
}

export { MAX_GOVERNED_MARKDOWN_LENGTH };
