import { describe, expect, it, vi } from "vitest";
import { createOpenRouterEmbeddingClient, DEFAULT_EMBEDDING_MODEL } from "@/server/memory/embeddings";
import { MEMORY_EMBEDDING_DIMENSIONS } from "@/server/memory/types";

function vector(seed: number) {
  return Array.from({ length: MEMORY_EMBEDDING_DIMENSIONS }, (_, index) => seed + index / 10_000);
}

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

describe("OpenRouter embedding client", () => {
  it("posts a batch and restores provider items to input order", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({
      model: DEFAULT_EMBEDDING_MODEL,
      data: [
        { index: 1, embedding: vector(2) },
        { index: 0, embedding: vector(1) },
      ],
    }));
    const client = createOpenRouterEmbeddingClient({ apiKey: "mock-key", fetchImpl });
    const result = await client.embed(["first", "second"]);
    expect(result).toEqual([vector(1), vector(2)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ authorization: "Bearer mock-key" });
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: DEFAULT_EMBEDDING_MODEL, input: ["first", "second"], dimensions: 1536 });
  });

  it("does not call the provider for an empty batch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createOpenRouterEmbeddingClient({ apiKey: "mock-key", fetchImpl });
    await expect(client.embed([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects missing keys, invalid dimensions, missing items, and provider bodies without leaking them", async () => {
    const noKey = createOpenRouterEmbeddingClient({ apiKey: "", fetchImpl: vi.fn<typeof fetch>() });
    await expect(noKey.embed(["one"])).rejects.toThrow("OPENROUTER_API_KEY is required");

    const invalid = createOpenRouterEmbeddingClient({
      apiKey: "mock-key",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ index: 0, embedding: [1, 2] }] })),
    });
    await expect(invalid.embed(["one"])).rejects.toThrow("exactly 1536");

    const missing = createOpenRouterEmbeddingClient({
      apiKey: "mock-key",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ index: 1, embedding: vector(1) }] })),
    });
    await expect(missing.embed(["one"])).rejects.toThrow("invalid item ordering");

    const providerFailure = createOpenRouterEmbeddingClient({
      apiKey: "mock-key",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ error: "provider-secret-body" }, 502)),
    });
    await expect(providerFailure.embed(["one"])).rejects.toThrow("(502)");
    await expect(providerFailure.embed(["one"])).rejects.not.toThrow("provider-secret-body");
  });

  it("rejects non-finite vector components and duplicate indexes", async () => {
    const nonFinite = createOpenRouterEmbeddingClient({
      apiKey: "mock-key",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ index: 0, embedding: [...vector(1).slice(0, -1), Number.NaN] }] })),
    });
    await expect(nonFinite.embed(["one"])).rejects.toThrow("finite numbers");

    const duplicate = createOpenRouterEmbeddingClient({
      apiKey: "mock-key",
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response({ data: [{ index: 0, embedding: vector(1) }, { index: 0, embedding: vector(2) }] })),
    });
    await expect(duplicate.embed(["one", "two"])).rejects.toThrow("invalid item ordering");
  });
});
