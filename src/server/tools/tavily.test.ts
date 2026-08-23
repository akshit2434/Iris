import { describe, expect, it, vi } from "vitest";

describe("tavily web search runner", () => {
  it("returns unconfigured without an API key", async () => {
    const { runWebSearch } = await import("./tavily");
    const output = await runWebSearch("latest iphones", {}, { apiKey: undefined });
    expect(output.status).toBe("unconfigured");
  });

  it("maps tavily results into concise citations", async () => {
    const { runWebSearch } = await import("./tavily");
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      void init;
      return new Response(JSON.stringify({
        results: [
          { title: "iPhone 18 review", url: "https://example.com/review", content: "Great camera. ".repeat(40), published_date: "2026-08-20" },
          { title: "No url here", content: "missing" },
        ],
      }), { status: 200 });
    });
    const output = await runWebSearch("iphone 18 review", { maxResults: 3 }, { apiKey: "tvly-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(output.status).toBe("ok");
    if (output.status !== "ok") return;
    expect(output.results).toHaveLength(1);
    expect(output.results[0]).toEqual({ title: "iPhone 18 review", url: "https://example.com/review", snippet: expect.stringContaining("Great camera"), publishedDate: "2026-08-20" });
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.max_results).toBe(3);
    expect(init.headers).toMatchObject({ authorization: "Bearer tvly-test" });
  });

  it("reports empty results distinctly", async () => {
    const { runWebSearch } = await import("./tavily");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const output = await runWebSearch("obscure query", {}, { apiKey: "tvly-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(output.status).toBe("empty");
  });

  it("never throws across the tool boundary", async () => {
    const { runWebSearch } = await import("./tavily");
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); });
    const output = await runWebSearch("anything", {}, { apiKey: "tvly-test", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(output.status).toBe("error");
    if (output.status === "error") expect(output.message).toContain("network down");
  });
});

describe("web_search tool registration", () => {
  it("is absent without TAVILY_API_KEY", async () => {
    vi.resetModules();
    const { createInternalTools } = await import("@/server/agent/tools");
    const names = createInternalTools(undefined, undefined, undefined, undefined, {}).map((tool) => tool.name);
    expect(names).not.toContain("web_search");
  });

  it("is registered when the key exists and not explicitly disabled", async () => {
    vi.resetModules();
    vi.stubEnv("TAVILY_API_KEY", "tvly-test");
    const { createInternalTools } = await import("@/server/agent/tools");
    const names = createInternalTools(undefined, undefined, undefined, undefined, {}).map((tool) => tool.name);
    expect(names).toContain("web_search");
    const disabled = createInternalTools(undefined, undefined, undefined, undefined, { webSearchEnabled: false }).map((tool) => tool.name);
    expect(disabled).not.toContain("web_search");
    vi.unstubAllEnvs();
  });
});
