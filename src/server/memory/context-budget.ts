import type { ProfileId } from "@/lib/profiles";
import type { MemoryItem } from "@/server/memory/types";
import { createTokenEstimator } from "@/server/agent/token-budget";

export const CANONICAL_MEMORY_MAX_ITEMS = 24;
export const CANONICAL_MEMORY_MAX_TOKENS = 6_000;

export type CanonicalMemoryContext = {
  globalRevision: number;
  items: Array<{ canonicalKey: string; content: string; category: string; itemRevision: number; updatedAt: string }>;
};

type BudgetItem = MemoryItem & { itemRevision?: number };
type BudgetOptions = { maxItems?: number; maxTokens?: number; profileId?: ProfileId; provider?: string; model?: string };

function priority(item: MemoryItem) {
  if (item.category === "instruction") return 0;
  if (item.category === "personal_fact" || item.category === "preference") return 1;
  if (item.category === "active_state" || item.category === "project" || item.category === "goal") return 2;
  return 3;
}

/** Select a deterministic, bounded snapshot for a fresh agent context. */
export function budgetCanonicalMemory(items: readonly BudgetItem[], globalRevision: number, options: BudgetOptions = {}): CanonicalMemoryContext {
  const maxItems = Math.max(0, Math.min(options.maxItems ?? CANONICAL_MEMORY_MAX_ITEMS, CANONICAL_MEMORY_MAX_ITEMS));
  const maxTokens = Math.max(0, Math.min(options.maxTokens ?? CANONICAL_MEMORY_MAX_TOKENS, CANONICAL_MEMORY_MAX_TOKENS));
  const estimator = createTokenEstimator({ provider: options.provider ?? "openrouter", model: options.model ?? "unknown" });
  const selected: CanonicalMemoryContext["items"] = [];
  let usedTokens = 0;
  const ordered = [...items]
    .filter((item) => item.status === "active" && (!options.profileId || item.profileId === options.profileId))
    .sort((left, right) => priority(left) - priority(right) || right.importance - left.importance || right.updatedAt.localeCompare(left.updatedAt) || left.canonicalKey.localeCompare(right.canonicalKey));
  for (const item of ordered) {
    if (selected.length >= maxItems || usedTokens >= maxTokens) break;
    const remaining = maxTokens - usedTokens;
    const fullEntry = `### ${item.canonicalKey}\n_${item.category}_\n\n${item.content}`;
    const fullTokens = estimator.estimateText(fullEntry);
    let content = item.content;
    if (fullTokens > remaining) {
      const prefix = `### ${item.canonicalKey}\n_${item.category}_\n\n`;
      const prefixTokens = estimator.estimateText(prefix);
      const fitted = estimator.truncateText(item.content, Math.max(0, remaining - prefixTokens));
      content = fitted.text;
    }
    if (!content) continue;
    const entryTokens = estimator.estimateText(`### ${item.canonicalKey}\n_${item.category}_\n\n${content}`);
    if (entryTokens > remaining) continue;
    selected.push({ canonicalKey: item.canonicalKey, content, category: item.category, itemRevision: item.itemRevision ?? 0, updatedAt: item.updatedAt });
    usedTokens += entryTokens;
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
