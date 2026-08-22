import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";

export const MISSED_COMMITMENT_MAX_PER_TURN = 2;
const SCANNER_TIMEOUT_MS = 20_000;

/** Tolerant extraction of commitment titles from a strict-JSON model reply. */
export function extractCommitmentTitles(raw: unknown): string[] {
  const content = typeof raw === "string" ? raw : raw && typeof raw === "object" && "content" in raw ? String((raw as { content?: unknown }).content ?? "") : "";
  if (!content.trim()) return [];
  const candidates = [content.trim()];
  for (const match of content.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1]);
  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(content.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const list = parsed && typeof parsed === "object" && Array.isArray((parsed as { commitments?: unknown }).commitments)
        ? (parsed as { commitments: unknown[] }).commitments
        : null;
      if (!list) continue;
      return list
        .map((item) => typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title : "")
        .map((title) => title.replace(/\s+/g, " ").trim())
        .filter((title) => title.length >= 3 && title.length <= 120)
        .slice(0, MISSED_COMMITMENT_MAX_PER_TURN);
    } catch {
      continue;
    }
  }
  return [];
}

/** Drop scanned titles that already match an open loop (case-insensitive containment either way). */
export function filterNewCommitments(titles: readonly string[], openLoopTitles: readonly string[]): string[] {
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  const tokenize = (value: string) => new Set(normalize(value).split(" ").filter(Boolean));
  const existing = openLoopTitles.map((title) => ({ text: normalize(title), tokens: tokenize(title) }));
  return titles.filter((title) => {
    const candidateText = normalize(title);
    if (!candidateText) return false;
    const candidateTokens = tokenize(title);
    return !existing.some(({ text, tokens }) => {
      if (text.includes(candidateText) || candidateText.includes(text)) return true;
      const intersection = [...candidateTokens].filter((token) => tokens.has(token)).length;
      const smaller = Math.min(candidateTokens.size, tokens.size) || 1;
      return intersection / smaller >= 0.5;
    });
  }).slice(0, MISSED_COMMITMENT_MAX_PER_TURN);
}

export type CommitmentScanner = (input: { userText: string; assistantText: string; openLoopTitles: readonly string[] }) => Promise<string[]>;

/** The only production scanner factory; tests inject a function instead. */
export function createProductionCommitmentScanner(): CommitmentScanner {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");
  const model = process.env.OPENROUTER_TITLE_MODEL ?? process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna";
  const client = new ChatOpenRouter({
    apiKey,
    model,
    temperature: 0,
    maxTokens: 220,
    modelKwargs: { reasoning: { effort: "none" } },
  });
  return async ({ userText, assistantText, openLoopTitles }) => {
    const knownLines = openLoopTitles.slice(0, 12).map((title) => `- ${title}`).join("\n") || "(none)";
    const prompt = `Decide whether the user's message stated concrete personal commitments/tasks they intend to do (errands, deadlines, appointments, one-off duties), and whether any of them were NOT already tracked as loops by the assistant.
Return strict JSON only: {"commitments":[{"title":"short imperative task title"}]}. Rules: only clear intentions or obligations, never ideas, wishes, questions, or routines that already exist; every listed title must be missing from the known-tracked list; maximum ${MISSED_COMMITMENT_MAX_PER_TURN} items; empty list when unsure.
<known-tracked-loops>
${knownLines}
</known-tracked-loops>
<user-message>${userText.slice(0, 1_200)}</user-message>
<assistant-reply>${assistantText.slice(0, 1_200)}</assistant-reply>`;
    try {
      const response = await Promise.race([
        client.invoke(prompt),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Commitment scanner timed out.")), SCANNER_TIMEOUT_MS)),
      ]);
      return extractCommitmentTitles(response);
    } catch {
      return [];
    }
  };
}
