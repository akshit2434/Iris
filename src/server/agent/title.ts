import "server-only";

import { ChatOpenRouter } from "@langchain/openrouter";
import { deriveThreadTitle, normalizeThreadTitle } from "@/lib/thread-title";
import { getConfiguredModelName } from "@/server/agent";

export type ThreadTitleGenerator = (request: string, options?: { signal?: AbortSignal }) => Promise<string>;

const TITLE_TIMEOUT_MS = 3500;

function messageText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part === "object" && part !== null && "text" in part) {
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? text : "";
    }
    return "";
  }).join("");
}

/** The only production title model factory; tests inject a generator instead. */
export function createProductionTitleGenerator(): ThreadTitleGenerator {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required.");

  const model = new ChatOpenRouter({
    apiKey,
    model: process.env.OPENROUTER_TITLE_MODEL ?? getConfiguredModelName(),
    temperature: 0,
    maxTokens: 24,
    stop: ["\n"],
    modelKwargs: { reasoning: { effort: "none" } },
  });

  return async (request, options) => {
    const response = await model.invoke([
      {
        role: "system",
        content: "Create one clean 2–6 word chat title from the user's request. Return only the title, without quotes, markdown, labels, or punctuation.",
      },
      { role: "user", content: request.slice(0, 12000) },
    ], options);
    return messageText(response.content);
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, controller: AbortController) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Title generation timed out.")), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    controller.abort();
  });
}

/** Resolve a title without ever making the assistant run depend on the provider. */
export async function resolveThreadTitle(input: {
  request: string;
  generator?: ThreadTitleGenerator;
  timeoutMs?: number;
}) {
  const fallback = deriveThreadTitle(input.request);
  const generator = input.generator ?? createProductionTitleGenerator();
  const controller = new AbortController();
  const generation = Promise.resolve().then(() => generator(input.request, { signal: controller.signal }));
  // Attach a rejection handler immediately so a late provider rejection cannot
  // become an unhandled promise after the timeout fallback wins the race.
  void generation.catch(() => undefined);
  try {
    const generated = await withTimeout(generation, input.timeoutMs ?? TITLE_TIMEOUT_MS, controller);
    return normalizeThreadTitle(generated, fallback);
  } catch {
    return fallback;
  }
}
