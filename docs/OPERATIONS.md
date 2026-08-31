# Operations guide

Runtime configuration, background workers, scheduling, and live verification for self-hosting Iris. Workflow rules live in [AGENTS.md](../AGENTS.md); the system map lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## Environment variables

### Required

| Variable | Purpose |
| --- | --- |
| `IRIS_APP_PIN` | Shared private access gate (server-only). |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Server-only database connection. Never prefix with `NEXT_PUBLIC_`. |
| `OPENROUTER_API_KEY` | Server-only model access. |

The files migration creates the private `iris-files` Supabase Storage bucket. No additional application secret is required; the server-only Supabase service-role client performs storage operations and issues short-lived signed URLs.

`ASSEMBLYAI_API_KEY` is optional and server-only. When configured, the chat composer enables ten-minute push-to-talk dictation through AssemblyAI's pre-recorded API. Iris sends bounded normal-sensitivity memory terms and context as transcription hints, stores the returned text and job metadata, and requests provider-side transcript deletion after completion. Raw audio is not stored by Iris.

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

### Voice dictation

| Variable | Default | Purpose |
| --- | --- | --- |
| `ASSEMBLYAI_API_KEY` | unset | Enables protected AssemblyAI transcription routes and the chat composer mic. |

Voice recordings are capped in the browser at ten minutes and stop automatically at that boundary. Iris does not impose an additional arbitrary byte-size rejection; the app submits a pre-recorded AssemblyAI job, returns immediately, and polls from the browser, so no Vercel function remains open while a long recording is processed. The provider request uses Universal 3.5 Pro with Universal 2 fallback, Hindi/English code-switching, normal-sensitivity memory context, keyterm prompting, and a deletion request after the result is saved. Active jobs can be cancelled from the composer, which aborts client polling and requests provider-side deletion.

### Future latency plan

The current pre-recorded flow is intentionally the first implementation: it is cheaper and keeps the AssemblyAI key server-side. The next latency phase is AssemblyAI Universal-3 Pro Streaming over a browser WebSocket with a short-lived server-minted token. An `AudioWorklet` would send 16 kHz mono PCM16 frames while the user speaks; partial turns would replace the current mutable draft, and only final turns would be committed to the composer. The existing async route should remain as the fallback for unsupported browsers and failed streaming sessions.

Streaming is billed for WebSocket session duration, so Iris must open the session only while the mic is active and always terminate it on stop or cancel. At the current published rates, Universal-3 Pro Streaming is about $0.45/hour versus about $0.21/hour for pre-recorded Universal-3.5 Pro, before any optional prompting add-on. A short Hinglish evaluation set must confirm Hindi-English accuracy on the streaming model before it becomes the default; the current public model table lists its native language coverage differently from Universal-2. See the [AssemblyAI pricing](https://www.assemblyai.com/pricing), [streaming billing](https://www.assemblyai.com/docs/faq/how-does-universal-streaming-session-based-pricing-work), and [model comparison](https://www.assemblyai.com/docs/getting-started/models) pages when this phase is scheduled.

### Script-only (not used by the app server)

`IRIS_RUN_LIVE_MEMORY_ACCEPTANCE`, `IRIS_ACCOUNTABILITY_BASE_URL`, `IRIS_ALLOW_REMOTE_LIVE_ACCOUNTABILITY`, `IRIS_RUN_LIVE_FILES_ACCEPTANCE`, `IRIS_FILES_BASE_URL`, `IRIS_ALLOW_REMOTE_LIVE_FILES`, `IRIS_LIVE_ACCEPTANCE_RESULT_FILE` — used by `scripts/live-*.mjs` acceptance harnesses.

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

Deterministic unit/contract tests never touch the network. Optional live harnesses verify real provider + database behavior against a **local** Supabase instance:

```bash
node scripts/live-memory-acceptance.mjs          # memory write/read round-trip
node scripts/live-accountability-acceptance.mjs  # loop -> sweep -> delivery -> assertions
IRIS_RUN_LIVE_FILES_ACCEPTANCE=1 node scripts/live-files-acceptance.mjs # multipart upload -> real LLM file task -> cleanup
```

The live harnesses are opt-in. The files harness requires a reachable Iris server, local Supabase, and an OpenRouter key; set `IRIS_ALLOW_REMOTE_LIVE_FILES=1` only if you deliberately want to use a remote database with synthetic data. It uploads and deletes a tagged file, checks profile isolation, and caps the real model request count.

For a realistic persistent-chat smoke test, start the app, authenticate in the browser, and send several normal follow-ups in the same thread. The verified local scenario used five prompts: narrow a fictional project, convert it into a schedule, challenge the plan, recover from lost time, and produce a final brief. The test thread and its accountability delivery were removed afterward; the synthetic wording was intentionally rejected by memory consolidation rather than saved as personal memory.

## Troubleshooting notes (from live operation)

- **Background jobs fail fast with generic errors** — raise `MEMORY_WORKER_MAX_DURATION_MS` first; reasoning models that spend their whole budget thinking return empty content under tight bounds. Structured `job_failed` lines in the server log carry the real error.
- **Free-tier model rate limits** surface as visible "could not complete this run" turns. Space concurrent calls or upgrade the model tier; the chat path itself never depends on background workers.
- **Missed sweep windows** self-heal: overdue checks are delivered on the next sweep with catch-up phrasing, and stale claims retry after ten minutes.
