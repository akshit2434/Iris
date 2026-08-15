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

Raw messages remain immutable source history. Markdown is the canonical current
representation; hashes, embeddings, rankings, timestamps, and provenance IDs
are runtime metadata rather than Markdown fields. RLS is enabled with no
browser policies because the current app uses a server-only service-role
connection and explicitly scopes every query.

## Later slices

- governed agent memory tools and human-visible proposals
- post-turn/idle consolidation and conflict handling
- embedding backfill/queue policy and retention controls
- exact-message retrieval/deep links and thread memory deltas
- stale-state reconciliation and long-chat compaction

No production LLM memory-write tool or automatic embedding trigger belongs in
this slice.
