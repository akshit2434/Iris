# Architecture

Iris is a conversation-first personal agent: one runtime per profile, chat as the primary interface, and everything else (memory, accountability, tools) reachable from conversation. This map explains how a message flows and where each concern lives. Product rules live in the private context pack; this document covers the running system.

## Turn flow (the spine)

```
POST /api/threads/[threadId]/messages
  1. Auth          gate cookie + profile cookie  (src/server/auth/)
  2. Load          thread, history, continuity checkpoint, canonical memory,
                   memory-change hint, open loops + recently closed, historical
                   preflight        (src/server/{db,memory,accountability}/)
  3. Budget        token-budgeted context assembly with a ledger
                   (src/server/agent/context-assembler.ts, token-budget.ts)
  4. Stream        LangChain agent (createAgent) -> OpenRouter; NDJSON events
                   versioned as iris.agent.stream.v1
                   (src/server/agent/{index,protocol,context}.ts)
  5. Persist       raw user + assistant messages, agent run, tool events,
                   token ledger       (src/server/db/queries.ts, agent/observability.ts)
  6. after()       lazy accountability sweep + missed-commitment scan
                   (src/server/accountability/{sweeper,scanner}.ts)
```

The system prompt is assembled per turn (`buildDynamicSystemPrompt`): temporal context, capability controls, accountability guidance, and untrusted runtime blocks (`<open-loops>`, canonical memory, reference history, preflight) with explicit do-not-follow-instructions framing.

## Subsystems

| Module | Owns | Notes |
| --- | --- | --- |
| `src/server/agent/` | Runtime, context building, internal tools, protocol, titles, token budget, observability | Tools registered behind capability flags; every tool returns structured outputs, never throws across the boundary. |
| `src/server/memory/` | Governed memory (proposals -> revisions -> sources), retrieval (lexical + semantic), consolidation/"dreaming", compaction, reference history, reconciliation | Raw `messages` are immutable source history; everything derived is replaceable. Optimistic revisions + idempotency keys on every mutation. |
| `src/server/accountability/` | Open loops (commitment/routine/idea), scheduled checks, merged check-in deliveries, suppressions, soft-close reconciliation, escalation tone, briefing | Person-scoped, not thread-scoped; thread IDs are provenance only. Atomic claim RPC makes sweeps concurrency-safe. See module README + `docs/MILESTONE_4_ACCOUNTABILITY.md`. |
| `src/server/tools/` | External tool integrations (`tavily.ts` web search) | Env-gated registration; REST, no SDK dependency. |
| `src/server/files/` | Profile-scoped file metadata, private Storage access, upload/read/open tools | Server-only Supabase Storage access; reads are capability-gated and signed URLs are short-lived. |
| `src/server/transcription/` | AssemblyAI upload/job polling, profile vocabulary context, correction learning | Audio is provider-bound and never stored in Iris; local job rows remain profile-scoped so polling cannot cross profiles. |
| `src/server/db/` | Server-only Supabase client, queries, generated-style `Database` types | Every query carries `profile_id`. |
| `src/server/auth/` | PIN gate + profile cookie resolution | |
| `src/components/`, `src/lib/` | Mobile-first UI; client stream reducer (`agent-stream.ts`) mirrors the server protocol | |

## Data model (by domain)

- **Chat/agent:** `profiles`, `threads`, `messages` (immutable raw history), `agent_runs`, `agent_events`, `thread_context`.
- **Memory:** `memory_items` + `_revisions` + `_sources`, `memory_suppressions`, `message_semantic_index`, consolidation/continuity/reference-history job tables, `profile_memory_settings`.
- **Accountability:** `open_loops`, `loop_events` (append-only), `scheduled_checks`, `checkin_deliveries` + `_items`, `loop_suppressions`.
- **Files/artifacts:** `files` metadata plus private `iris-files` Storage bucket; uploaded files and generated artifacts share the row shape and are distinguished by `record_kind`.
- **Voice:** `voice_transcriptions` tracks short-lived AssemblyAI jobs and returned text; `voice_vocabulary` stores only explicit correction terms separately from governed personal memory.

All tables: RLS enabled, revoked from `public/anon/authenticated`, composite `(id, profile_id)` foreign keys, append-only ledgers protected by immutability triggers. Migrations are contract-tested against SQL shape without a live database.

## Delivery model (accountability)

Reminders are database rows with `due_at`. The lazy post-turn sweep delivers when a human can see it; an optional cron heartbeat bounds lateness and powers future Web Push. Check-in messages are composed at delivery time — deterministic templates for simple cases (zero tokens), a small model for merges/reflections/catch-ups, and full agent re-entry only when the user replies.

## Extension conventions

- Dependency-injected seams everywhere (repository/client/model/fetch), so tests run without network or database using fakes.
- Migration-contract tests assert SQL shape as text; unit tests pin tool names, protocol shapes, and state-machine transitions.
- New capabilities follow the pattern: schema migration -> repository methods with profile guards -> pure domain logic -> tool wrapper with structured output -> env-gated registration -> prompt guidance -> UI suppression-list entry if outputs are JSON.
- The stream protocol is versioned (`iris.agent.stream.v1`); additive event types only.

## Deliberate non-goals (current)

No multi-tenant auth product, no dashboards-first UX, no streak mechanics, no always-on model polling. Background work is event-driven and bounded; the chat path never depends on it.
