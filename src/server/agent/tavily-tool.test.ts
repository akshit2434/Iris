import { describe, expect, it, vi } from "vitest";
import { createAgentContext } from "@/server/agent/context";
import { createInternalTools, getInternalToolSchemaDescriptors, tavilySearch } from "@/server/agent/tools";

describe("tavily_search tool integration", () => {
  it("includes tavily_search tool by default and respects webSearchEnabled flag", () => {
    const defaultTools = createInternalTools();
    const toolNamesDefault = defaultTools.map((tool) => tool.name);
    expect(toolNamesDefault).toContain("tavily_search");

    const disabledTools = createInternalTools(undefined, undefined, undefined, undefined, {
      webSearchEnabled: false,
    });
    const toolNamesDisabled = disabledTools.map((tool) => tool.name);
    expect(toolNamesDisabled).not.toContain("tavily_search");
  });

  it("includes tavily_search in schema descriptors for token accounting", () => {
    const descriptors = getInternalToolSchemaDescriptors();
    const tavilyDescriptor = descriptors.find((item) => item.name === "tavily_search");
    expect(tavilyDescriptor).toBeDefined();
    expect(tavilyDescriptor?.description).toMatch(/search the web using tavily/i);
    expect(tavilyDescriptor?.parameters).toBeDefined();
  });

  it("invokes custom search handler when provided", async () => {
    const context = createAgentContext({
      profileId: "profile-a",
      profileLabel: "User",
      threadId: "00000000-0000-4000-8000-000000000001",
      threadTitle: "Test Search",
    });

    const mockCustomSearch = vi.fn().mockResolvedValue({
      kind: "web_search",
      ok: true,
      query: "iris agent AI",
      results: [
        {
          title: "Iris Personal AI Layer",
          url: "https://example.com/iris",
          content: "Iris is a private AI personal assistant.",
          score: 0.99,
        },
      ],
    });

    const result = await tavilySearch(
      context,
      { query: "iris agent AI", searchDepth: "basic", maxResults: 3 },
      mockCustomSearch,
    );

    expect(mockCustomSearch).toHaveBeenCalledWith({
      query: "iris agent AI",
      searchDepth: "basic",
      topic: undefined,
      maxResults: 3,
    });

    expect(result).toEqual({
      kind: "web_search",
      ok: true,
      query: "iris agent AI",
      results: [
        {
          title: "Iris Personal AI Layer",
          url: "https://example.com/iris",
          content: "Iris is a private AI personal assistant.",
          score: 0.99,
        },
      ],
    });
  });
});
