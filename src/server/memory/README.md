# Memory foundation

Milestone 3 Slice 1 establishes the server-only boundary for memory without
changing the chat UI or invoking a model.

## What exists now

- `supabase/migrations/20260817000000_memory_foundation.sql` adds profile-scoped
  canonical Markdown documents, immutable revisions, provenance, profile-global
  revisions, a replaceable semantic message index, generated message FTS, and
  lexical/hybrid search plus atomic document-revision RPCs.
- `types.ts` separates canonical documents/revisions from derived search data.
- `repository.ts` is the injected Supabase store boundary. Every operation
  requires a `profileId`; it never relies on an ID alone.
- `embeddings.ts` is a small injectable OpenRouter `/api/v1/embeddings` client.
  It defaults to `openai/text-embedding-3-small`, requests 1536 dimensions, and
  validates batch ordering and finite vector dimensions. It is not wired into
  message sending yet.
- `indexer.ts` hashes raw message content and idempotently refreshes only stale
  or model-changed derived vectors.
- `retrieval.ts` is the read-only, injected query boundary for exact historical
  message windows, bounded lexical message search, and active canonical-document
  inspection. Its production semantic path is opt-in via
  `MEMORY_SEMANTIC_SEARCH_ENABLED` and has no provider unless one is explicitly
  injected, so ordinary chat requests do not spend embedding credits.
- `src/server/agent/tools.ts` exposes only profile-scoped `search_messages`,
  `read_messages`, `memory_list`, `memory_read`, and `memory_search` reads. Their
  structured results can carry bounded internal source actions for the chat UI;
  there is deliberately no memory write/consolidation tool.

Raw messages remain immutable source history. Markdown is the canonical current
representation; hashes, embeddings, rankings, timestamps, and provenance IDs
are runtime metadata rather than Markdown fields. RLS is enabled with no
browser policies because the current app uses a server-only service-role
connection and explicitly scopes every query.

## Later slices

- governed memory writes, human-visible proposals, and consolidation
- post-turn/idle consolidation and conflict handling
- embedding backfill/queue policy and retention controls
- thread memory deltas and source-ranking improvements
- stale-state reconciliation and long-chat compaction

No production LLM memory-write tool or automatic embedding trigger belongs in
this slice.
