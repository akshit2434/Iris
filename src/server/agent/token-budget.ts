import type { MessageRole } from "@/lib/types";

/**
 * Provider/model metadata is intentionally explicit. OpenRouter can route a
 * model to a provider whose tokenizer Iris cannot safely identify, so the
 * default estimator is conservative and clearly marked as such.
 */
export type TokenizerMetadata = {
  provider: string;
  model: string;
  mode: "exact" | "conservative";
  version: string;
};

export type TokenEstimate = {
  tokens: number;
  truncated: boolean;
};

export type TokenEstimator = {
  metadata: TokenizerMetadata;
  estimateText(value: string): number;
  estimateJson(value: unknown): number;
  estimateMessage(message: { role: MessageRole; content: string }): number;
  truncateText(value: string, maxTokens: number): TokenEstimate & { text: string };
};

export const CONSERVATIVE_TOKENIZER_VERSION = "iris-conservative-v1";

function boundedInteger(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
}

function utf8Bytes(value: string) {
  return new TextEncoder().encode(value).length;
}

function stableJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "undefined") return "null";
  if (typeof value === "function" || typeof value === "symbol") return "null";
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry, seen)).join(",")}]`;
  if (typeof value !== "object") return "null";
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  const record = value as Record<string, unknown>;
  const body = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`)
    .join(",");
  seen.delete(value);
  return `{${body}}`;
}

/**
 * Conservative local estimation used until an exact provider/model tokenizer
 * is positively identified. Three Unicode code points per token intentionally
 * overestimates ordinary English and remains deterministic for tests.
 */
function conservativeTextEstimate(value: string) {
  if (value.length === 0) return 0;
  const codePoints = Array.from(value).length;
  const bytes = utf8Bytes(value);
  const structural = (value.match(/[\n\r\t{}[\]():,]/g) ?? []).length;
  return Math.max(1, Math.ceil(Math.max(codePoints / 3, bytes / 4) + structural / 12));
}

function createConservativeEstimator(provider: string, model: string): TokenEstimator {
  const metadata: TokenizerMetadata = {
    provider,
    model,
    mode: "conservative",
    version: CONSERVATIVE_TOKENIZER_VERSION,
  };

  const estimateText = (value: string) => conservativeTextEstimate(value);
  const estimateJson = (value: unknown) => {
    // JSON punctuation and field names are part of the serialized request. A
    // small fixed envelope covers message/tool framing not present in values.
    const serialized = stableJson(value);
    return estimateText(serialized) + (serialized.length > 0 ? 4 : 0);
  };
  const estimateMessage = (message: { role: MessageRole; content: string }) =>
    estimateJson({ role: message.role, content: message.content });

  const truncateText = (value: string, maxTokens: number): TokenEstimate & { text: string } => {
    const budget = Math.max(0, Math.floor(maxTokens));
    if (!value || budget === 0) return { text: "", tokens: 0, truncated: value.length > 0 };
    if (estimateText(value) <= budget) return { text: value, tokens: estimateText(value), truncated: false };

    const codePoints = Array.from(value);
    let low = 0;
    let high = codePoints.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = codePoints.slice(0, middle).join("");
      if (estimateText(candidate) <= budget) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    // Keep the truncation marker inside the token budget. It is useful to the
    // model and never causes the current user turn to be silently shortened.
    const marker = "…";
    while (best && estimateText(`${best}${marker}`) > budget) {
      best = Array.from(best).slice(0, -1).join("");
    }
    const text = best ? `${best}${marker}` : "";
    return { text, tokens: estimateText(text), truncated: true };
  };

  return { metadata, estimateText, estimateJson, estimateMessage, truncateText };
}

/**
 * Create a tokenizer adapter for one provider/model pair. No network call or
 * paid tokenizer is made. Exact adapters can be added only after a tokenizer
 * is confidently matched to the provider/model pair; none are assumed here.
 */
export function createTokenEstimator(input: { provider?: string; model?: string } = {}): TokenEstimator {
  return createConservativeEstimator(input.provider?.trim() || "unknown", input.model?.trim() || "unknown");
}

export function estimateUncertainty(tokens: number, rate = 0.1) {
  return boundedInteger(Math.ceil(Math.max(0, tokens) * Math.max(0, rate)));
}
