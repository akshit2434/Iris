import type { ProfileId } from "@/lib/profiles";
import type { MemoryItem } from "@/server/memory/types";

export const CANONICAL_MEMORY_MAX_ITEMS = 24;
export const CANONICAL_MEMORY_MAX_CHARACTERS = 6_000;

export type CanonicalMemoryContext = {
  globalRevision: number;
  items: Array<{ canonicalKey: string; content: string; category: string; itemRevision: number; updatedAt: string }>;
};

type BudgetItem = MemoryItem & { itemRevision?: number };
type BudgetOptions = { maxItems?: number; maxCharacters?: number; profileId?: ProfileId };

function priority(item: MemoryItem) {
  if (item.category === "instruction") return 0;
  if (item.category === "personal_fact" || item.category === "preference") return 1;
  if (item.category === "active_state" || item.category === "project" || item.category === "goal") return 2;
  return 3;
}

/** Select a deterministic, bounded snapshot for a fresh agent context. */
export function budgetCanonicalMemory(items: readonly BudgetItem[], globalRevision: number, options: BudgetOptions = {}): CanonicalMemoryContext {
  const maxItems = Math.max(0, Math.min(options.maxItems ?? CANONICAL_MEMORY_MAX_ITEMS, CANONICAL_MEMORY_MAX_ITEMS));
  const maxCharacters = Math.max(0, Math.min(options.maxCharacters ?? CANONICAL_MEMORY_MAX_CHARACTERS, CANONICAL_MEMORY_MAX_CHARACTERS));
  const selected: CanonicalMemoryContext["items"] = [];
  let usedCharacters = 0;
  const ordered = [...items]
    .filter((item) => item.status === "active" && (!options.profileId || item.profileId === options.profileId))
    .sort((left, right) => priority(left) - priority(right) || right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt) || left.canonicalKey.localeCompare(right.canonicalKey));
  for (const item of ordered) {
    if (selected.length >= maxItems || usedCharacters >= maxCharacters) break;
    const remaining = maxCharacters - usedCharacters;
    const content = item.content.slice(0, remaining);
    if (!content) continue;
    selected.push({ canonicalKey: item.canonicalKey, content, category: item.category, itemRevision: item.itemRevision ?? 0, updatedAt: item.updatedAt });
    usedCharacters += content.length;
  }
  return { globalRevision: Number.isSafeInteger(globalRevision) && globalRevision >= 0 ? globalRevision : 0, items: selected };
}

function escapePrompt(value: string) {
  return value.replace(/[<>]/g, (character) => character === "<" ? "&lt;" : "&gt;");
}

/** Render structured items as a small Markdown-like model view. */
export function formatCanonicalMemoryPrompt(memory: CanonicalMemoryContext) {
  if (memory.items.length === 0) return "";
  const body = memory.items.map((item) => `### ${item.canonicalKey}\n_${item.category}_\n\n${escapePrompt(item.content)}`).join("\n\n");
  return `<saved-memory global-revision="${memory.globalRevision}">\n${body}\n</saved-memory>`;
}
