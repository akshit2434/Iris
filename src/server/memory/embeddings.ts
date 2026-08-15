import "server-only";

import { MEMORY_EMBEDDING_DIMENSIONS } from "@/server/memory/types";
import { validateEmbedding, validateEmbeddingModel } from "@/server/memory/validation";

export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
const EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";

export type EmbeddingProvider = {
  readonly model: string;
  embed: (inputs: readonly string[]) => Promise<number[][]>;
};

type OpenRouterEmbeddingResponse = {
  data?: Array<{ index?: unknown; embedding?: unknown }>;
  model?: unknown;
};

type OpenRouterEmbeddingClientOptions = {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
};

function safeProviderError(status: number) {
  return new Error(`Embedding provider request failed (${status}).`);
}

function parseEmbeddingResponse(value: unknown, expectedCount: number) {
  if (!value || typeof value !== "object" || !Array.isArray((value as OpenRouterEmbeddingResponse).data)) {
    throw new Error("Embedding provider returned an invalid response.");
  }
  const data = (value as OpenRouterEmbeddingResponse).data ?? [];
  if (data.length !== expectedCount) throw new Error("Embedding provider returned an unexpected batch length.");

  const ordered = new Array<number[]>(expectedCount);
  for (const item of data) {
    if (!item || typeof item.index !== "number" || !Number.isInteger(item.index) || item.index < 0 || item.index >= expectedCount || ordered[item.index]) {
      throw new Error("Embedding provider returned invalid item ordering.");
    }
    if (!Array.isArray(item.embedding)) throw new Error("Embedding provider returned an invalid vector.");
    ordered[item.index] = validateEmbedding(item.embedding.map((value) => typeof value === "number" ? value : Number.NaN)).slice() as number[];
  }
  if (ordered.some((vector) => !vector)) throw new Error("Embedding provider omitted a batch item.");
  return ordered;
}

export function createOpenRouterEmbeddingClient(options: OpenRouterEmbeddingClientOptions = {}): EmbeddingProvider {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  const model = validateEmbeddingModel(options.model ?? process.env.OPENROUTER_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL);
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? EMBEDDINGS_URL;

  return {
    model,
    async embed(inputs) {
      if (inputs.length === 0) return [];
      if (!apiKey?.trim()) throw new Error("OPENROUTER_API_KEY is required for embeddings.");
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model, input: [...inputs], dimensions: MEMORY_EMBEDDING_DIMENSIONS }),
      });
      if (!response.ok) throw safeProviderError(response.status);
      const body = await response.json() as unknown;
      return parseEmbeddingResponse(body, inputs.length);
    },
  };
}
