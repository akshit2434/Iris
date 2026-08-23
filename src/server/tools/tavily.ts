import "server-only";

import { tool, type ToolRuntime } from "langchain";
import { z } from "zod";
import type { AgentContext } from "@/server/agent/context";

const TAVILY_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const WEB_SEARCH_TIMEOUT_MS = 15_000;
const WEB_SEARCH_MAX_RESULTS = 8;

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedDate: string | null;
};

export type WebSearchOutput =
  | { kind: "web_search"; status: "ok"; query: string; results: WebSearchResult[] }
  | { kind: "web_search"; status: "empty"; query: string }
  | { kind: "web_search"; status: "unconfigured"; query: string }
  | { kind: "web_search"; status: "error"; query: string; message: string };

export const webSearchInput = z.object({
  query: z.string().min(2).max(400),
  maxResults: z.number().int().min(1).max(WEB_SEARCH_MAX_RESULTS).optional(),
  topic: z.enum(["general", "news"]).optional(),
});

type TavilySearchResponse = {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }>;
};

/** Pure search runner; fetch is injectable for deterministic tests. */
export async function runWebSearch(
  query: string,
  options: { maxResults?: number; topic?: "general" | "news" } = {},
  deps: { apiKey?: string; fetchImpl?: typeof fetch } = {},
): Promise<WebSearchOutput> {
  const apiKey = deps.apiKey ?? process.env.TAVILY_API_KEY;
  if (!apiKey) return { kind: "web_search", status: "unconfigured", query };
  const boundedQuery = query.trim().slice(0, 400);
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(TAVILY_SEARCH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query: boundedQuery,
        max_results: Math.min(Math.max(options.maxResults ?? 5, 1), WEB_SEARCH_MAX_RESULTS),
        topic: options.topic ?? "general",
        search_depth: "basic",
        include_answer: false,
      }),
      signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { kind: "web_search", status: "error", query: boundedQuery, message: "Web search rejected the configured Tavily key." };
    }
    if (!response.ok) {
      return { kind: "web_search", status: "error", query: boundedQuery, message: `Web search failed with HTTP ${response.status}.` };
    }
    const payload = (await response.json()) as TavilySearchResponse;
    const results = (payload.results ?? [])
      .map((result) => ({
        title: typeof result.title === "string" ? result.title.slice(0, 300) : "",
        url: typeof result.url === "string" ? result.url : "",
        snippet: typeof result.content === "string" ? result.content.slice(0, 600) : "",
        publishedDate: typeof result.published_date === "string" ? result.published_date : null,
      }))
      .filter((result) => result.url.length > 0);
    if (results.length === 0) return { kind: "web_search", status: "empty", query: boundedQuery };
    return { kind: "web_search", status: "ok", query: boundedQuery, results };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Web search failed.";
    return { kind: "web_search", status: "error", query: boundedQuery, message };
  }
}

export function createWebSearchTool(fetchImpl?: typeof fetch) {
  return tool(
    async (input: z.infer<typeof webSearchInput>, runtime: ToolRuntime<unknown, AgentContext>) =>
      runWebSearch(input.query, { maxResults: input.maxResults, topic: input.topic }, { fetchImpl }),
    {
      name: "web_search",
      description:
        "Search the live web when current or external information matters: recent events, facts you are unsure about, prices or schedules that change, or when the user's assumption may be wrong. Return concise results with URLs and cite them inline as plain links; never claim to have opened or read a full page. Do not use it for personal memories, saved facts, or self-contained knowledge you already have.",
      schema: webSearchInput,
    },
  );
}
