import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { getConfiguredModelName } from "@/server/agent";

export type CheckinKind = "single_commitment" | "merged_batch" | "routine_reflection" | "catch_up" | "soft_close_confirm";

export type CheckinLoopRef = { title: string; evidenceExcerpt?: string };

export type CheckinComposer = (input: { kind: CheckinKind; loops: CheckinLoopRef[] }) => Promise<string>;

export type ComposedCheckin = { text: string; tier: 0 | 1 };

const COMPOSER_TIMEOUT_MS = 6000;
const COMPOSER_MAX_TOKENS = 220;
const COMPOSER_MAX_CHARS = 1200;
export const SOFT_CLOSE_EXCERPT_MAX_CHARS = 80;

export function truncateAtWordBoundary(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength);
  const boundary = Math.max(sliced.lastIndexOf(" "), sliced.lastIndexOf("\n"));
  return (boundary > 0 ? sliced.slice(0, boundary) : sliced).trimEnd();
}

const TIER_ONE_KINDS: readonly CheckinKind[] = ["merged_batch", "routine_reflection", "catch_up"];

function bulletList(loops: CheckinLoopRef[]): string {
  return loops.map((loop) => `- ${loop.title}`).join("\n");
}

function joinedTitles(loops: CheckinLoopRef[]): string {
  const titles = loops.map((loop) => loop.title);
  if (titles.length <= 1) return titles[0] ?? "";
  return `${titles.slice(0, -1).join(", ")} and ${titles[titles.length - 1]}`;
}

export function composeTier0Text(input: { kind: CheckinKind; loops: CheckinLoopRef[] }): string {
  const titles = input.loops.length > 0 ? input.loops : [{ title: "your open loop" }];
  switch (input.kind) {
    case "merged_batch":
      return [
        "Quick check on a few things you had planned:",
        bulletList(titles),
        "",
        "Which ones are done, and which could use more time?",
      ].join("\n");
    case "routine_reflection":
      return `Time for your check-in: how has ${joinedTitles(titles)} been going lately?`;
    case "catch_up": {
      const plural = titles.length > 1;
      const subject = `${joinedTitles(titles)} ${plural ? "slipped past their dates" : "slipped past its date"} — no judgment.`;
      return `${subject} Want to pick ${plural ? "them" : "it"} up today, or should we find a better time?`;
    }
    case "soft_close_confirm": {
      const excerpt = input.loops.find((loop) => loop.evidenceExcerpt)?.evidenceExcerpt;
      if (!excerpt) return composeTier0Text({ kind: "single_commitment", loops: input.loops });
      const quoted = truncateAtWordBoundary(excerpt, SOFT_CLOSE_EXCERPT_MAX_CHARS);
      return `Saw you mention finishing ${joinedTitles(titles)} — "${quoted}". Want me to close it out?`;
    }
    case "single_commitment":
    default:
      return `Quick check: did you get to ${joinedTitles(titles)} yet? Even a quick yes or no helps.`;
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Check-in composition timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    controller.abort();
  });
}

/** The only production check-in model factory; sweeps inject a generator in tests. */
export function createProductionCheckinComposer(): CheckinComposer {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");

  const modelName = process.env.OPENROUTER_TITLE_MODEL ?? getConfiguredModelName();
  const model = new ChatOpenRouter({
    apiKey,
    model: modelName,
    temperature: 0,
    maxTokens: COMPOSER_MAX_TOKENS,
    modelKwargs: { reasoning: { effort: "none" } },
  });

  return async ({ kind, loops }) => {
    const controller = new AbortController();
    const generation = model.invoke(
      [
        {
          role: "system",
          content:
            "You write one short warm accountability nudge for the user's open loops. Sound like a considerate friend, never robotic or guilt-tripping. Plain text only: no markdown, no quotes around the whole message, at most three short lines.",
        },
        {
          role: "user",
          content: `Kind of check-in: ${kind}. Open loops:\n${bulletList(loops)}`,
        },
      ],
      { signal: controller.signal },
    );
    void generation.catch(() => undefined);
    const response = await withTimeout(generation, COMPOSER_TIMEOUT_MS, controller);
    const text = typeof response.content === "string" ? response.content : String(response.content ?? "");
    return truncateAtWordBoundary(text.trim(), COMPOSER_MAX_CHARS);
  };
}

/** Tier rules live here: single fresh commitments stay deterministic, everything else tries the small model. */
export async function composeCheckinMessage(input: {
  kind: CheckinKind;
  loops: CheckinLoopRef[];
  composer?: CheckinComposer;
}): Promise<ComposedCheckin> {
  const isTierOne = TIER_ONE_KINDS.includes(input.kind);
  if (!isTierOne || input.loops.length === 0) {
    return { text: composeTier0Text({ kind: input.kind, loops: input.loops }), tier: 0 };
  }
  try {
    const composer = input.composer ?? createProductionCheckinComposer();
    const generated = await composer({ kind: input.kind, loops: input.loops });
    const normalized = generated.trim();
    if (!normalized) throw new Error("The composer returned an empty check-in.");
    return { text: normalized, tier: 1 };
  } catch {
    return { text: composeTier0Text({ kind: input.kind, loops: input.loops }), tier: 0 };
  }
}
