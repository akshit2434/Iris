import type { CanonicalMemoryDocument } from "@/server/memory/types";
import type { ProfileId } from "@/lib/profiles";

export const CANONICAL_MEMORY_MAX_DOCUMENTS = 8;
export const CANONICAL_MEMORY_MAX_CHARACTERS = 6_000;

export type CanonicalMemoryContext = {
  globalRevision: number;
  documents: Array<Pick<CanonicalMemoryDocument, "logicalKey" | "contentMarkdown" | "documentRevision" | "updatedAt">>;
};

type BudgetOptions = {
  maxDocuments?: number;
  maxCharacters?: number;
  profileId?: ProfileId;
};

function priority(logicalKey: string) {
  const normalized = logicalKey.toLocaleUpperCase();
  if (normalized === "PROFILE" || normalized === "PROFILE.MD") return 0;
  if (normalized === "CURRENT" || normalized === "CURRENT.MD") return 1;
  return 2;
}

/** Select a deterministic, bounded snapshot for a fresh agent context. */
export function budgetCanonicalMemory(
  documents: readonly CanonicalMemoryDocument[],
  globalRevision: number,
  options: BudgetOptions = {},
): CanonicalMemoryContext {
  const maxDocuments = Math.max(0, Math.min(options.maxDocuments ?? CANONICAL_MEMORY_MAX_DOCUMENTS, CANONICAL_MEMORY_MAX_DOCUMENTS));
  const maxCharacters = Math.max(0, Math.min(options.maxCharacters ?? CANONICAL_MEMORY_MAX_CHARACTERS, CANONICAL_MEMORY_MAX_CHARACTERS));
  const selected: CanonicalMemoryContext["documents"] = [];
  let usedCharacters = 0;

  const ordered = [...documents]
    .filter((document) => !document.archivedAt && (!options.profileId || document.profileId === options.profileId))
    .sort((left, right) => priority(left.logicalKey) - priority(right.logicalKey)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.logicalKey.localeCompare(right.logicalKey));

  for (const document of ordered) {
    if (selected.length >= maxDocuments || usedCharacters >= maxCharacters) break;
    const remaining = maxCharacters - usedCharacters;
    if (remaining <= 0) break;
    const content = document.contentMarkdown.slice(0, remaining);
    if (!content) continue;
    selected.push({
      logicalKey: document.logicalKey,
      contentMarkdown: content,
      documentRevision: document.documentRevision,
      updatedAt: document.updatedAt,
    });
    usedCharacters += content.length;
  }

  return {
    globalRevision: Number.isSafeInteger(globalRevision) && globalRevision >= 0 ? globalRevision : 0,
    documents: selected,
  };
}

export function formatCanonicalMemoryPrompt(memory: CanonicalMemoryContext) {
  if (memory.documents.length === 0) return "";
  const body = memory.documents.map((document) => `<memory-document key="${document.logicalKey}" revision="${document.documentRevision}">\n${document.contentMarkdown.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;")}\n</memory-document>`).join("\n");
  return `<canonical-memory global-revision="${memory.globalRevision}">\n${body}\n</canonical-memory>`;
}
