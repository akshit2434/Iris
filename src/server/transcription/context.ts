import type { MemoryItem } from "@/server/memory/types";
import type { VoiceVocabularyEntry } from "@/server/transcription/types";

const MAX_KEYTERMS = 1000;
const MAX_PROMPT_CHARS = 2500;
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "because", "before", "between", "could", "from", "have", "into", "just", "more", "only", "that", "their", "there", "these", "they", "this", "through", "under", "user", "what", "when", "where", "which", "with", "would", "your",
  "और", "आप", "आपका", "आपकी", "एक", "इस", "कर", "का", "के", "को", "में", "ने", "पर", "यह", "से", "है", "हो", "और",
]);

function normalizeTerm(value: string) {
  return value.replace(/\s+/g, " ").trim().replace(/^[,.;:!?()[\]{}]+|[,.;:!?()[\]{}]+$/g, "");
}

function addTerm(target: string[], seen: Set<string>, value: string) {
  const term = normalizeTerm(value);
  if (term.length < 2 || term.length > 120) return;
  const key = term.toLocaleLowerCase();
  if (STOP_WORDS.has(key) || seen.has(key)) return;
  seen.add(key);
  target.push(term);
}

function humanizeKey(value: string) {
  return value.replace(/[._:/-]+/g, " ").replace(/\s+/g, " ").trim();
}

function extractTermsFromContent(content: string, target: string[], seen: Set<string>) {
  for (const match of content.matchAll(/[“"]([^”"]{2,120})[”"]/gu)) addTerm(target, seen, match[1] ?? "");
  for (const match of content.matchAll(/\b(?:[A-Z][A-Za-z0-9._/-]*)(?:\s+[A-Z][A-Za-z0-9._/-]*){0,4}\b/g)) addTerm(target, seen, match[0] ?? "");
  for (const match of content.matchAll(/[\p{Script=Devanagari}][\p{Script=Devanagari}0-9-]{2,}/gu)) addTerm(target, seen, match[0] ?? "");
}

export function buildVoiceKeyterms(items: readonly Pick<MemoryItem, "canonicalKey" | "content" | "sensitivity" | "importance">[], vocabulary: readonly Pick<VoiceVocabularyEntry, "term" | "occurrenceCount">[] = []) {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const entry of [...vocabulary].sort((left, right) => right.occurrenceCount - left.occurrenceCount)) addTerm(terms, seen, entry.term);
  for (const item of [...items].filter((item) => item.sensitivity === "normal").sort((left, right) => right.importance - left.importance)) {
    addTerm(terms, seen, humanizeKey(item.canonicalKey));
    extractTermsFromContent(item.content, terms, seen);
    if (terms.length >= MAX_KEYTERMS) break;
  }
  return terms.slice(0, MAX_KEYTERMS);
}

export function buildVoiceContextPrompt(items: readonly Pick<MemoryItem, "canonicalKey" | "content" | "sensitivity" | "importance">[]) {
  const lines = [...items]
    .filter((item) => item.sensitivity === "normal")
    .sort((left, right) => right.importance - left.importance)
    .slice(0, 20)
    .map((item) => `${humanizeKey(item.canonicalKey)}: ${item.content.replace(/\s+/g, " ").trim().slice(0, 180)}`);
  return lines.join("; ").slice(0, MAX_PROMPT_CHARS);
}

function tokenise(value: string) {
  return [...value.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’._/-]*/gu)].map((match) => match[0] ?? "");
}

export function extractVocabularyCorrections(original: string, corrected: string) {
  const originalTokens = new Set(tokenise(original).map((token) => token.toLocaleLowerCase()));
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenise(corrected)) {
    const normalized = token.toLocaleLowerCase();
    if (originalTokens.has(normalized) || normalized.length < 4 || STOP_WORDS.has(normalized)) continue;
    if (!/[A-Z\d\p{Script=Devanagari}_./-]/u.test(token)) continue;
    addTerm(terms, seen, token);
  }
  return terms.slice(0, 20);
}

export function buildAssemblyPrompt(context: string) {
  const suffix = context ? ` Relevant personal vocabulary and context: ${context}` : "";
  return `Personal voice dictation in Hindi, English, or naturally code-switched Hindi-English. Preserve the spoken language; do not translate. Keep punctuation, names, technical terms, and numbers accurate.${suffix}`.slice(0, 4000);
}
