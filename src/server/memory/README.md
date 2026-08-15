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
- `mutation.ts` adds the governed `memory_patch` write seam. It accepts only a
  full replacement Markdown document, requires the active persisted user
  message/run provenance and an optimistic revision, and derives its
  idempotency key from the run/tool call. It cannot archive or delete.
- `20260818000000_memory_governance.sql` adds idempotent revisions, proposal
  records, and a database-backed leased queue. Successful runs enqueue one job;
  the worker is opt-in only (`MEMORY_CONSOLIDATION_ENABLED=true`) and requires
  `MEMORY_WORKER_SECRET` at the protected internal route. No cron or automatic
  model call is configured. Queue writes happen after successful persisted
  runs even while processing is disabled; no extra LLM request happens inline.
- `context-budget.ts` injects at most eight active profile documents and 6,000
  Markdown characters into a fresh agent context. Empty memory adds no prompt
  block; the global revision is carried outside the Markdown content.
- `consolidation.ts` validates bounded, source-owned proposals and applies them
  through the atomic proposal/RPC path. Semantic indexing remains separately
  opt-in with `MEMORY_SEMANTIC_INDEXING_ENABLED=true`; its failure never rolls
  back canonical memory.

The default runtime behavior is therefore: lexical retrieval and bounded
canonical context injection are available, `memory_patch` is governed and
user-triggered only, semantic query/indexing is off, and consolidation workers
do no work until explicitly enabled and authenticated. Slice 4 owns
`memory_revision_seen` reconciliation, review UX, explicit archive/forget, and
embedding/backfill policy.

Raw messages remain immutable source history. Markdown is the canonical current
representation; hashes, embeddings, rankings, timestamps, and provenance IDs
are runtime metadata rather than Markdown fields. RLS is enabled with no
browser policies because the current app uses a server-only service-role
connection and explicitly scopes every query.

## Later slices

- thread memory deltas and `memory_revision_seen` reconciliation
- human-facing proposal review/rejection UX and explicit archive/forget
- embedding backfill/queue policy, retention controls, and richer ranking
- stale-state reconciliation and long-chat compaction

No production LLM memory-write tool or automatic embedding trigger belongs in
this slice.
