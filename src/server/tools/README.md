# Tools boundary

Hosts external tool integrations for the Iris agent runtime.

- `tavily.ts` — live web search via the Tavily REST API. Registered only when
  `TAVILY_API_KEY` is configured and `webSearchEnabled` is not disabled.
  Server-only; the key never reaches the browser.
- `../files/tools.ts` — profile-scoped file and artifact listing, bounded text
  reads, and short-lived signed download URLs. Registered only when
  `filesEnabled` is explicitly granted.
