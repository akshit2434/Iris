# Memory foundation

Milestone 3 establishes a server-only, profile-scoped memory layer without
changing raw transcript history. Canonical Markdown is governed and auditable;
derived search/index data is replaceable.

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
- `20260819000000_memory_reconciliation_compaction.sql` adds monotonic
  `thread_context.memory_revision_seen` advancement, fresh-thread baselines,
  governed archive support, and a leased `thread_compaction_jobs` queue. It
  never deletes or updates raw `messages` rows.
- `reconciliation.ts` collapses changes since an old thread's last successful
  revision into a small untrusted prompt hint. The request captures a memory
  revision snapshot; only a completed run advances `memory_revision_seen`, and
  concurrent newer changes remain for the next turn.
- `memory_archive` is the only forget/archive write. It requires an active
  user-turn provenance and expected document revision, appends an immutable
  archive revision, and retains the final document plus raw history. It is not
  legal or physical erasure; no hard-delete tool exists.
- `compaction.ts` accepts an injected strict compactor and processes only
  leased jobs. It stores a bounded continuity summary and pinned notes only
  after an optimistic checkpoint match; newer summaries win races. The model
  receives an older ordered slice and the chat route sends only the verbatim
  tail after the checkpoint when continuity exists.
- Thread compaction enqueue defaults to `80` messages with a `24` message
  recent tail (`THREAD_COMPACTION_MIN_MESSAGES` and
  `THREAD_COMPACTION_RECENT_TAIL_MESSAGES`). Processing is off until
  `THREAD_COMPACTION_ENABLED=true`; the protected worker route also requires
  `MEMORY_WORKER_SECRET`. Consolidation and compaction are bounded to a tiny
  authenticated worker request and never run an extra model call inline after
  a chat turn.
- `/api/memory` and `/memory` expose a read-only active/archived inspection
  surface. Detail revisions show only bounded Markdown, safe provenance, and
  validated internal `Open source` actions. The desktop shell links Memory;
  mobile access is through Profile without changing the five-slot nav.

The default runtime behavior is therefore: lexical retrieval and bounded
canonical context injection are available, `memory_patch` and `memory_archive`
are governed and user-triggered only, semantic query/indexing is off, and both
consolidation and compaction workers do no work until explicitly enabled and
authenticated. Queue writes are cheap and replay-safe; no automatic model
call is made by ordinary chat or by queue enqueue.

Raw messages remain immutable source history. Markdown is the canonical current
representation; hashes, embeddings, rankings, timestamps, and provenance IDs
are runtime metadata rather than Markdown fields. RLS is enabled with no
browser policies because the current app uses a server-only service-role
connection and explicitly scopes every query.

## Bounded acceptance

`src/server/memory/acceptance.test.ts` runs a no-network Chat A → canonical
write → Chat B recall/source → old Chat A revision-delta scenario with injected
fakes. A separate synthetic provider check is prepared at
`scripts/live-memory-acceptance.mjs`; it requires
`IRIS_RUN_LIVE_MEMORY_ACCEPTANCE=1`, uses at most two short model requests and
synthetic text only, prints pass/fail plus call count, and never touches Iris's
Supabase tables. Do not run it as part of ordinary checks; the later hosted
acceptance follow-up must explicitly opt in and review cost first.

## Later slices

- human-facing proposal review/rejection UX
- embedding backfill/queue policy, retention controls, and richer ranking
- richer compaction review and stale-thread reconciliation UX

No automatic embedding trigger or unbounded memory-write path belongs in this
slice; all writes remain governed by the runtime services above.
