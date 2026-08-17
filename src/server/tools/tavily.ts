import "server-only";

export type TavilySearchDepth = "basic" | "advanced";
export type TavilyTopic = "general" | "news";

export type TavilySearchInput = {
  query: string;
  searchDepth?: TavilySearchDepth;
  topic?: TavilyTopic;
  maxResults?: number;
};

export type TavilySearchResultItem = {
  title: string;
  url: string;
  content: string;
  score: number;
  publishedDate?: string;
};

export type TavilySearchResponse = {
  kind: "web_search";
  ok: boolean;
  query: string;
  results: TavilySearchResultItem[];
  answer?: string;
  error?: string;
};

export async function searchTavily(
  input: TavilySearchInput,
  options?: { apiKey?: string; fetchFn?: typeof fetch },
): Promise<TavilySearchResponse> {
  const query = input.query.trim();
  const apiKey = options?.apiKey ?? process.env.TAVILY_API_KEY;

  if (!apiKey) {
    return {
      kind: "web_search",
      ok: false,
      query,
      results: [],
      error: "TAVILY_API_KEY is not configured.",
    };
  }

  const fetchImpl = options?.fetchFn ?? fetch;

  try {
    const response = await fetchImpl("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: input.searchDepth ?? "basic",
        topic: input.topic ?? "general",
        max_results: input.maxResults ?? 5,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      return {
        kind: "web_search",
        ok: false,
        query,
        results: [],
        error: `Tavily API returned status ${response.status}: ${errorText || response.statusText}`,
      };
    }

    const data = (await response.json()) as {
      query?: string;
      answer?: string;
      results?: Array<{
        title?: string;
        url?: string;
        content?: string;
        score?: number;
        published_date?: string;
      }>;
    };

    const results: TavilySearchResultItem[] = Array.isArray(data.results)
      ? data.results.map((item) => ({
          title: item.title ?? "",
          url: item.url ?? "",
          content: item.content ?? "",
          score: typeof item.score === "number" ? item.score : 0,
          ...(item.published_date ? { publishedDate: item.published_date } : {}),
        }))
      : [];

    return {
      kind: "web_search",
      ok: true,
      query,
      results,
      ...(data.answer ? { answer: data.answer } : {}),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      kind: "web_search",
      ok: false,
      query,
      results: [],
      error: `Failed to search Tavily: ${errorMessage}`,
    };
  }
}
