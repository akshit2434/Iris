# Tools boundary

Hosts external tool integrations for the Iris agent runtime.

- `tavily.ts` — live web search via the Tavily REST API. Registered only when
  `TAVILY_API_KEY` is configured and `webSearchEnabled` is not disabled.
  Server-only; the key never reaches the browser.
