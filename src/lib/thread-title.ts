const MAX_TITLE_WORDS = 6;
const MAX_TITLE_LENGTH = 72;

function cleanTitleText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[`*_>#]+/g, " ")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^(?:title|subject)\s*:\s*/i, "")
    .replace(/^[-•\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?;:,，。！？…]+$/u, "")
    .trim();
}

/** Keep provider output short, plain, and safe to render as a chat label. */
export function normalizeThreadTitle(value: string, fallback: string) {
  const cleaned = cleanTitleText(value);
  const words = cleaned.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  const normalized = words.join(" ").slice(0, MAX_TITLE_LENGTH).trim();
  if (words.length >= 2) return normalized;
  const fallbackWords = cleanTitleText(fallback).split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  return fallbackWords.length >= 2 ? fallbackWords.join(" ").slice(0, MAX_TITLE_LENGTH).trim() : normalized || fallback;
}

/** Deterministic local fallback used when the tiny title request is unavailable. */
export function deriveThreadTitle(content: string) {
  const cleaned = cleanTitleText(content);
  const words = cleaned.split(" ").filter(Boolean).slice(0, MAX_TITLE_WORDS);
  const fallback = words.join(" ").slice(0, MAX_TITLE_LENGTH).trim();
  return fallback || "New chat";
}
