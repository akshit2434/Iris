import type { ProfileId } from "@/lib/profiles";
import type { MemoryRevisionDelta, MemoryStore } from "@/server/memory/types";

export const MEMORY_CHANGE_HINT_MAX_ITEMS = 8;
export const MEMORY_CHANGE_HINT_MAX_CHARACTERS = 2_400;

export type MemoryChangeHint = {
  afterRevision: number;
  throughRevision: number;
  changes: MemoryRevisionDelta[];
};

function escapeRuntimeText(value: string) {
  return value.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;");
}

/** Collapse a revision range to one latest change per canonical item key. */
export function collapseMemoryChanges(
  changes: readonly MemoryRevisionDelta[],
  afterRevision: number,
  throughRevision: number,
  options: { maxItems?: number } = {},
): MemoryChangeHint {
  const maxItems = Math.max(0, Math.min(options.maxItems ?? MEMORY_CHANGE_HINT_MAX_ITEMS, MEMORY_CHANGE_HINT_MAX_ITEMS));
  const latest = new Map<string, MemoryRevisionDelta>();
  for (const change of changes) {
    if (change.profileGlobalRevision <= afterRevision || change.profileGlobalRevision > throughRevision) continue;
    const previous = latest.get(change.canonicalKey);
    if (!previous || change.profileGlobalRevision > previous.profileGlobalRevision) latest.set(change.canonicalKey, change);
  }
  return {
    afterRevision,
    throughRevision,
    changes: [...latest.values()]
      .sort((left, right) => right.profileGlobalRevision - left.profileGlobalRevision || left.canonicalKey.localeCompare(right.canonicalKey))
      .slice(0, maxItems),
  };
}

export function formatMemoryChangeHint(hint: MemoryChangeHint) {
  if (hint.changes.length === 0) return "";
  let used = 0;
  const body = hint.changes.flatMap((change) => {
    if (used >= MEMORY_CHANGE_HINT_MAX_CHARACTERS) return [];
    const excerpt = escapeRuntimeText(change.excerpt).slice(0, MEMORY_CHANGE_HINT_MAX_CHARACTERS - used);
    used += excerpt.length;
    return `<memory-change key="${escapeRuntimeText(change.canonicalKey)}" mutation="${change.mutationKind}" revision="${change.itemRevision}" global-revision="${change.profileGlobalRevision}" status="${change.status}">${excerpt}</memory-change>`;
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
