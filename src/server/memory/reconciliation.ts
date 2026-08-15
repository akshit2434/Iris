import type { ProfileId } from "@/lib/profiles";
import type { MemoryRevisionDelta, MemoryStore } from "@/server/memory/types";

export const MEMORY_CHANGE_HINT_MAX_DOCUMENTS = 8;
export const MEMORY_CHANGE_HINT_MAX_CHARACTERS = 2_400;

export type MemoryChangeHint = {
  afterRevision: number;
  throughRevision: number;
  changes: MemoryRevisionDelta[];
};

function escapeRuntimeText(value: string) {
  return value.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;");
}

/** Collapse a revision range to one latest change per logical document key. */
export function collapseMemoryChanges(
  changes: readonly MemoryRevisionDelta[],
  afterRevision: number,
  throughRevision: number,
  options: { maxDocuments?: number } = {},
): MemoryChangeHint {
  const maxDocuments = Math.max(0, Math.min(options.maxDocuments ?? MEMORY_CHANGE_HINT_MAX_DOCUMENTS, MEMORY_CHANGE_HINT_MAX_DOCUMENTS));
  const latest = new Map<string, MemoryRevisionDelta>();
  for (const change of changes) {
    if (change.profileGlobalRevision <= afterRevision || change.profileGlobalRevision > throughRevision) continue;
    const previous = latest.get(change.logicalKey);
    if (!previous || change.profileGlobalRevision > previous.profileGlobalRevision) latest.set(change.logicalKey, change);
  }
  return {
    afterRevision,
    throughRevision,
    changes: [...latest.values()]
      .sort((left, right) => right.profileGlobalRevision - left.profileGlobalRevision || left.logicalKey.localeCompare(right.logicalKey))
      .slice(0, maxDocuments),
  };
}

export function formatMemoryChangeHint(hint: MemoryChangeHint) {
  if (hint.changes.length === 0) return "";
  let used = 0;
  const body = hint.changes.flatMap((change) => {
    if (used >= MEMORY_CHANGE_HINT_MAX_CHARACTERS) return [];
    const excerpt = escapeRuntimeText(change.excerpt).slice(0, MEMORY_CHANGE_HINT_MAX_CHARACTERS - used);
    used += excerpt.length;
    return `<memory-change key="${escapeRuntimeText(change.logicalKey)}" mutation="${change.mutationKind}" revision="${change.documentRevision}" global-revision="${change.profileGlobalRevision}" archived="${change.archivedAt ? "true" : "false"}">${excerpt}</memory-change>`;
  }).join("\n");
  return `<memory-changes since="${hint.afterRevision}" through="${hint.throughRevision}">
${body}
</memory-changes>`;
}

export async function readMemoryChangeHint(input: {
  store: MemoryStore;
  profileId: ProfileId;
  afterRevision: number;
  throughRevision: number;
  limit?: number;
}): Promise<MemoryChangeHint> {
  const changes = input.store.listMemoryChanges
    ? await input.store.listMemoryChanges(input.profileId, input.afterRevision, input.throughRevision, input.limit)
    : [];
  return collapseMemoryChanges(changes, input.afterRevision, input.throughRevision);
}

export function shouldAdvanceMemoryRevision(input: { runStatus: "completed" | "failed"; snapshotRevision: number; currentRevision?: number }) {
  return input.runStatus === "completed" && Number.isSafeInteger(input.snapshotRevision) && input.snapshotRevision >= 0
    && (input.currentRevision === undefined || input.currentRevision >= input.snapshotRevision);
}
