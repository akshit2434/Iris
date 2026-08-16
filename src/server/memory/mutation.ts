import "server-only";

import type { ProfileId } from "@/lib/profiles";
import type { AppliedMemoryItemRevision, MemoryItemCategory, MemoryItemValueScope, MemoryStore } from "@/server/memory/types";
import { assertMemoryProfileId, validateCanonicalKey, validateMemoryContent, validateMemoryUuid } from "@/server/memory/validation";

const MAX_GOVERNED_MEMORY_LENGTH = 20_000;

export type GovernedMemoryPatchInput = {
  profileId: ProfileId;
  threadId: string;
  currentUserMessageId: string;
  agentRunId: string;
  toolCallId: string;
  canonicalKey: string;
  content: string;
  expectedItemRevision: number | null;
  mutationKind: "create" | "update" | "supersede" | "merge";
  category?: MemoryItemCategory;
  valueScope?: MemoryItemValueScope;
};

export type GovernedMemoryPatchResult =
  | { status: "applied"; canonicalKey: string; revision: AppliedMemoryItemRevision }
  | { status: "conflict" | "stale"; canonicalKey: string; reason: string; candidates: string[] };

export type MemoryMutationService = { apply: (input: GovernedMemoryPatchInput) => Promise<GovernedMemoryPatchResult> };

function safeCandidates(items: readonly { canonicalKey: string }[]) { return items.slice(0, 5).map((item) => item.canonicalKey); }

function relatedItems(items: Awaited<ReturnType<MemoryStore["listItems"]>>, canonicalKey: string, content: string) {
  const terms = new Set(`${canonicalKey} ${content}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4));
  return items.filter((item) => {
    if (item.canonicalKey === canonicalKey) return true;
    const candidateTerms = `${item.canonicalKey} ${item.content}`.toLocaleLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length >= 4);
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
      const canonicalKey = validateCanonicalKey(input.canonicalKey);
      const content = validateMemoryContent(input.content.trim());
      if (content.length > MAX_GOVERNED_MEMORY_LENGTH) return { status: "conflict", canonicalKey, reason: "Memory patches are limited to 20,000 characters.", candidates: [] };
      if (input.mutationKind === "create" && input.expectedItemRevision !== null) return { status: "stale", canonicalKey, reason: "Create patches must use a null expected revision.", candidates: [] };
      if (input.mutationKind !== "create" && (input.expectedItemRevision === null || !Number.isSafeInteger(input.expectedItemRevision) || input.expectedItemRevision < 0)) return { status: "stale", canonicalKey, reason: "Update and merge patches require the current expected revision.", candidates: [] };
      const sourceContext = await store.readMessageContext(input.profileId, input.currentUserMessageId, 1);
      if (!sourceContext || sourceContext.thread.id !== input.threadId || sourceContext.target.profileId !== input.profileId || sourceContext.target.role !== "user") return { status: "conflict", canonicalKey, reason: "The current user message is not owned by this profile/thread.", candidates: [] };
      const items = await store.listItems(input.profileId, { includeArchived: true });
      const current = items.find((item) => item.canonicalKey === canonicalKey && item.status === "active");
      const archived = items.find((item) => item.canonicalKey === canonicalKey && item.status === "archived");
      const related = relatedItems(items, canonicalKey, content);
      if (input.mutationKind === "create" && current) return { status: "conflict", canonicalKey, reason: "An active memory item with this key already exists.", candidates: [canonicalKey] };
      if (input.mutationKind === "create" && !current && !archived && related.filter((item) => item.status === "active").length > 0) return { status: "conflict", canonicalKey, reason: "A related active memory item may already contain this fact.", candidates: safeCandidates(related.filter((item) => item.status === "active")) };
      if (input.mutationKind !== "create" && !current) return { status: "stale", canonicalKey, reason: "The active memory item no longer exists; reread memory before updating.", candidates: [] };
      if (current && input.expectedItemRevision !== null && current.itemRevision !== input.expectedItemRevision) return { status: "stale", canonicalKey, reason: "The memory item changed; reread it before updating.", candidates: [canonicalKey] };
      const mutationKind = input.mutationKind === "create" && archived ? "restore" as const : input.mutationKind;
      const expectedItemRevision = mutationKind === "restore" ? archived?.itemRevision ?? null : input.expectedItemRevision;
      try {
        const revision = await store.applyItemRevision({
          profileId: input.profileId, canonicalKey, content, category: input.category ?? "other", valueScope: input.valueScope ?? "single",
          origin: "explicit", confidence: 1, importance: 0.7, sensitivity: "normal", status: "active", mutationKind,
          expectedItemRevision, idempotencyKey: `memory-patch:${input.agentRunId}:${input.toolCallId}`,
          provenance: { sourceKind: "message", sourceThreadId: input.threadId, sourceMessageId: input.currentUserMessageId, sourceExcerpt: content.slice(0, 2_000) },
        });
        if (store.liftSuppression) await store.liftSuppression(input.profileId, canonicalKey);
        return { status: "applied", canonicalKey, revision };
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (/stale|already exists|idempotency/i.test(message)) return { status: "stale", canonicalKey, reason: "The memory item changed; reread it before updating.", candidates: current ? [canonicalKey] : [] };
        throw new Error("Memory mutation could not be applied.");
      }
    },
  };
}

export { MAX_GOVERNED_MEMORY_LENGTH };
