import { describe, expect, it, vi } from "vitest";
import { searchTavily } from "./tavily";

describe("searchTavily", () => {
  it("returns error when TAVILY_API_KEY is missing and not provided in options", async () => {
    const originalKey = process.env.TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;

    try {
      const result = await searchTavily({ query: "latest tech news" });
      expect(result).toEqual({
        kind: "web_search",
        ok: false,
        query: "latest tech news",
        results: [],
        error: "TAVILY_API_KEY is not configured.",
      });
    } finally {
      process.env.TAVILY_API_KEY = originalKey;
    }
  });

  it("calls Tavily endpoint and formats search results correctly", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        query: "nextjs 16 updates",
        results: [
          {
            title: "Next.js 16 Released",
            url: "https://nextjs.org/blog/next-16",
            content: "Next.js 16 brings massive performance improvements.",
            score: 0.98,
            published_date: "2026-08-01",
          },
        ],
      }),
    });

    const result = await searchTavily(
      { query: "nextjs 16 updates", searchDepth: "advanced", maxResults: 3 },
      { apiKey: "tvly-test-key", fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/search",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: "tvly-test-key",
          query: "nextjs 16 updates",
          search_depth: "advanced",
          topic: "general",
          max_results: 3,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
      }),
    );

    expect(result).toEqual({
      kind: "web_search",
      ok: true,
      query: "nextjs 16 updates",
      results: [
        {
          title: "Next.js 16 Released",
          url: "https://nextjs.org/blog/next-16",
          content: "Next.js 16 brings massive performance improvements.",
          score: 0.98,
          publishedDate: "2026-08-01",
        },
      ],
    });
  });

  it("handles non-200 HTTP response status gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: async () => "Invalid API key",
    });

    const result = await searchTavily(
      { query: "test query" },
      { apiKey: "tvly-invalid-key", fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(result).toEqual({
      kind: "web_search",
      ok: false,
      query: "test query",
      results: [],
      error: "Tavily API returned status 401: Invalid API key",
    });
  });

  it("handles fetch network exception gracefully", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("Network connection lost"));

    const result = await searchTavily(
      { query: "test network failure" },
      { apiKey: "tvly-key", fetchFn: mockFetch as unknown as typeof fetch },
    );

    expect(result).toEqual({
      kind: "web_search",
      ok: false,
      query: "test network failure",
      results: [],
      error: "Failed to search Tavily: Network connection lost",
    });
  });
});
