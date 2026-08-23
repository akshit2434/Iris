# Operations guide

Runtime configuration, background workers, scheduling, and live verification for self-hosting Iris. Workflow rules live in [AGENTS.md](../AGENTS.md); the system map lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## Environment variables

### Required

| Variable | Purpose |
| --- | --- |
| `IRIS_APP_PIN` | Shared private access gate (server-only). |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Server-only database connection. Never prefix with `NEXT_PUBLIC_`. |
| `OPENROUTER_API_KEY` | Server-only model access. |

### Model selection

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_MODEL` | `openai/gpt-5.6-luna` | Main agent model. |
| `OPENROUTER_TITLE_MODEL` | `OPENROUTER_MODEL` | Cheap model for first-turn titles and other small background calls (check-in composition, missed-commitment scan). |
| `OPENROUTER_EMBEDDING_MODEL` | provider default | Embeddings for the semantic index/search. |

### Web search

| Variable | Default | Purpose |
| --- | --- | --- |
| `TAVILY_API_KEY` | unset | Enables the `web_search` agent tool. Unset = tool invisible to the model; no other behavior changes. |

### Memory workers

| Variable | Default | Purpose |
| --- | --- | --- |
| `MEMORY_WORKER_SECRET` | unset | Server-only secret for `x-iris-worker-secret` on all internal worker endpoints (memory + accountability sweep). |
| `MEMORY_WORKER_MAX_DURATION_MS` | `25000` (clamped 5s–300s) | Per-sweep time bound for background workers. Raise for slow local/free models — reasoning models that return empty content under tight budgets are the usual failure signature. |
| `MEMORY_CONSOLIDATION_ENABLED` | `true` | Durable-memory proposal pipeline ("dreaming"). |
| `MEMORY_REFERENCE_HISTORY_ENABLED` | `true` | Per-profile reference-document synthesis. |
| `MEMORY_SEMANTIC_INDEXING_ENABLED` | `true` | Message embedding index maintenance. |
| `MEMORY_SEMANTIC_SEARCH_ENABLED` | `true` | Semantic recall at query time. |
| `MEMORY_CONTINUITY_ENABLED` | `false` | Thread-continuity compaction worker. |

### Accountability

| Variable | Default | Purpose |
| --- | --- | --- |
| `ACCOUNTABILITY_SWEEP_DISABLED` | `false` | Disables the lazy post-turn sweep trigger (the endpoint still works). |
| `ACCOUNTABILITY_SCANNER_DISABLED` | `false` | Disables the missed-commitment background scan. |

### Script-only (not used by the app server)

`IRIS_RUN_LIVE_MEMORY_ACCEPTANCE`, `IRIS_ACCOUNTABILITY_BASE_URL`, `IRIS_ALLOW_REMOTE_LIVE_ACCOUNTABILITY`, `IRIS_LIVE_ACCEPTANCE_RESULT_FILE` — used by `scripts/live-*.mjs` acceptance harnesses.

## Background worker endpoints

Both endpoints are POST-only, authenticated by the `x-iris-worker-secret` header, idempotent, and safe to call concurrently.

| Endpoint | Job |
| --- | --- |
| `/api/internal/memory/consolidate` | Claims and processes pending memory-consolidation, continuity (if enabled), and reference-history jobs. Body `{ "limit": 1..3 }`. |
| `/api/internal/accountability/sweep` | Claims due scheduled checks, composes and delivers merged check-ins, reconciles stated completions, seeds the daily briefing. Body `{ "limit": 1..8 }`. |

## Scheduling model

- **Primary trigger is lazy**: every persisted chat turn fires a sweep via `after()`, so a single user gets timely delivery with zero infrastructure.
- **Heartbeat (optional, for push-grade reliability):** call the sweep endpoint from any scheduler at your preferred interval. Requirements to know:
  - Daily morning briefings need at least one sweep between 00:00 and 08:00 UTC (briefing time is UTC in this version).
  - Escalation counters advance per delivery, not per sweep; extra sweeps without due checks are one indexed query and cost nothing.
  - The claim RPC (`FOR UPDATE SKIP LOCKED`) makes concurrent triggers safe.
- A one-line crontab is enough: `*/5 * * * * curl -fsS -X POST $URL/api/internal/accountability/sweep -H "x-iris-worker-secret: $SECRET" >/dev/null`

## Live acceptance

Deterministic unit/contract tests never touch the network. Two optional live harnesses verify real provider + database behavior against a **local** Supabase instance:

```bash
node scripts/live-memory-acceptance.mjs          # memory write/read round-trip
node scripts/live-accountability-acceptance.mjs  # loop -> sweep -> delivery -> assertions
```

Both self-skip with a clear reason when credentials or a local server are missing, and refuse to seed remote databases without `IRIS_ALLOW_REMOTE_LIVE_ACCOUNTABILITY=1`.

## Troubleshooting notes (from live operation)

- **Background jobs fail fast with generic errors** — raise `MEMORY_WORKER_MAX_DURATION_MS` first; reasoning models that spend their whole budget thinking return empty content under tight bounds. Structured `job_failed` lines in the server log carry the real error.
- **Free-tier model rate limits** surface as visible "could not complete this run" turns. Space concurrent calls or upgrade the model tier; the chat path itself never depends on background workers.
- **Missed sweep windows** self-heal: overdue checks are delivered on the next sweep with catch-up phrasing, and stale claims retry after ten minutes.
