import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { getConfiguredModelName } from "@/server/agent";

export type CheckinKind = "single_commitment" | "merged_batch" | "routine_reflection" | "catch_up" | "soft_close_confirm";

export type CheckinLoopRef = { title: string; evidenceExcerpt?: string };

export type CheckinComposerInput = { kind: CheckinKind; loops: CheckinLoopRef[]; escalationTier: number };

export type CheckinComposer = (input: CheckinComposerInput) => Promise<string>;

export type ComposedCheckin = { text: string; tier: 0 | 1 };

export function toneTierForEscalation(escalationTier: number): 0 | 1 | 2 {
  if (!Number.isFinite(escalationTier) || escalationTier <= 0) return 0;
  return escalationTier === 1 ? 1 : 2;
}

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

export function composeTier0Text(input: { kind: CheckinKind; loops: CheckinLoopRef[]; escalationTier?: number }): string {
  const titles = input.loops.length > 0 ? input.loops : [{ title: "your open loop" }];
  const tone = toneTierForEscalation(input.escalationTier ?? 0);
  switch (input.kind) {
    case "merged_batch": {
      if (tone === 1) {
        return [
          "A gentle reminder about these:",
          bulletList(titles),
          "",
          "No rush — just let me know where each one stands.",
        ].join("\n");
      }
      if (tone >= 2) {
        return [
          "These keep slipping past their dates:",
          bulletList(titles),
          "",
          "What changed? We can reschedule any of them, or drop the ones that no longer matter.",
        ].join("\n");
      }
      return [
        "Quick check on a few things you had planned:",
        bulletList(titles),
        "",
        "Which ones are done, and which could use more time?",
      ].join("\n");
    }
    case "routine_reflection": {
      const subject = joinedTitles(titles);
      if (tone === 1) return `Whenever you have a moment today, I'd love to hear how ${subject} has been going.`;
      if (tone >= 2) return `${subject} keeps sliding past their check-ins — still working for you? Happy to adjust the rhythm or let it go.`;
      return `Time for your check-in: how has ${subject} been going lately?`;
    }
    case "catch_up": {
      const plural = titles.length > 1;
      const names = joinedTitles(titles);
      if (tone === 1) {
        return `Just a gentle nudge about ${names}, which ${plural ? "have" : "has"} slipped past ${plural ? "their" : "its"} date. Want to pick ${plural ? "them" : "it"} up soon, or find a better time?`;
      }
      if (tone >= 2) {
        return `${names} ${plural ? "keep" : "keeps"} slipping — still important? Tell me what changed and we can reschedule ${plural ? "them" : "it"}, or drop ${plural ? "them" : "it"}.`;
      }
      return `${names} ${plural ? "slipped past their dates" : "slipped past its date"} — no judgment. Want to pick ${plural ? "them" : "it"} up today, or should we find a better time?`;
    }
    case "soft_close_confirm": {
      const names = joinedTitles(titles);
      if (tone >= 2) return `Still seeing ${names} open — close it for good?`;
      const excerpt = input.loops.find((loop) => loop.evidenceExcerpt)?.evidenceExcerpt;
      if (!excerpt) return composeTier0Text({ kind: "single_commitment", loops: input.loops, escalationTier: input.escalationTier });
      const quoted = truncateAtWordBoundary(excerpt, SOFT_CLOSE_EXCERPT_MAX_CHARS);
      if (tone === 1) return `Earlier you mentioned finishing ${names} — "${quoted}". Does closing it out sound right?`;
      return `Saw you mention finishing ${names} — "${quoted}". Want me to close it out?`;
    }
    case "single_commitment":
    default: {
      const names = joinedTitles(titles);
      const plural = titles.length > 1;
      if (tone === 1) return `Gentle reminder about ${names}: it's still on your list whenever you're ready.`;
      if (tone >= 2) return `${names} ${plural ? "keep" : "keeps"} slipping — still important? Tell me what changed and we can reschedule ${plural ? "them" : "it"} or drop ${plural ? "them" : "it"}.`;
      return `Quick check: did you get to ${names} yet? Even a quick yes or no helps.`;
    }
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

const KIND_TONE_HINTS: Record<CheckinKind, string> = {
  single_commitment: "This is a commitment the user made to themselves.",
  merged_batch: "These are commitments the user made to themselves.",
  routine_reflection:
    "This is a recurring routine, not a deadline — invite honest reflection instead of asking whether it got finished.",
  catch_up: "This commitment slipped well past its date — lead with understanding, zero guilt.",
  soft_close_confirm: "History suggests this may already be done — ask before closing it out.",
};

const TIER_TONE_HINTS: Record<0 | 1 | 2, string> = {
  0: "This is the first nudge, so stay neutral and light.",
  1: "This is a follow-up, so send a gentle reminder that stays low-pressure.",
  2: "This has been nudged several times already: kindly note that it keeps slipping, ask what changed, and offer to reschedule it or drop it.",
};

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

  return async ({ kind, loops, escalationTier }) => {
    const controller = new AbortController();
    const tone = toneTierForEscalation(escalationTier);
    const generation = model.invoke(
      [
        {
          role: "system",
          content:
            "You write one short warm accountability nudge for the user's open loops. Sound like a considerate friend, never robotic or guilt-tripping. Never punitive, never scolding, no streaks or scorekeeping. Plain text only: no markdown, no quotes around the whole message, at most three short lines.",
        },
        {
          role: "user",
          content: `Kind of check-in: ${kind}. Escalation level: ${tone}. ${KIND_TONE_HINTS[kind]} ${TIER_TONE_HINTS[tone]}\nOpen loops:\n${bulletList(loops)}`,
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
  escalationTier?: number;
  composer?: CheckinComposer;
}): Promise<ComposedCheckin> {
  const escalationTier = Math.max(0, input.escalationTier ?? 0);
  const isTierOne = TIER_ONE_KINDS.includes(input.kind);
  if (!isTierOne || input.loops.length === 0) {
    return { text: composeTier0Text({ kind: input.kind, loops: input.loops, escalationTier }), tier: 0 };
  }
  try {
    const composer = input.composer ?? createProductionCheckinComposer();
    const generated = await composer({ kind: input.kind, loops: input.loops, escalationTier });
    const normalized = generated.trim();
    if (!normalized) throw new Error("The composer returned an empty check-in.");
    return { text: normalized, tier: 1 };
  } catch {
    return { text: composeTier0Text({ kind: input.kind, loops: input.loops, escalationTier }), tier: 0 };
  }
}
