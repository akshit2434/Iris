# Structured memory foundation

Milestone 3, Slice 1 establishes a server-only, profile-scoped memory layer
without changing raw transcript history.

## Authority model

- Raw `messages` remain immutable source history.
- `memory_items` stores the current structured memory authority.
- `memory_item_revisions` stores immutable snapshots for every mutation.
- `memory_item_sources` stores exact message/thread/event provenance.
- `memory_suppressions` prevents forgotten items from being recreated by later
  derivation; archival writes the suppression atomically and explicit user
  writes lift matching suppression records.
- `message_semantic_index` and full-text search are replaceable indexes.
- Markdown is generated only at the context boundary for model readability.

Each item has a stable canonical key, natural-language content, category,
single/multi-value scope, origin, confidence, importance, sensitivity, status,
validity window, and confirmation timestamps. Database constraints enforce
profile ownership and at most one active value for a singleton key.

Mutations use optimistic item revisions, profile-global revisions, source
ownership checks, idempotency keys, and an atomic RPC. Lifecycle states are
`active`, `superseded`, `archived`, and `deleted`; archived/deleted items keep
raw history and revisions. Archive also creates a suppression record.

## Runtime boundaries

- `repository.ts` is the injected Supabase store. Every read and write carries
  a profile predicate.
- `retrieval.ts` exposes bounded lexical/hybrid message search and structured
  item search without requesting embeddings unless explicitly enabled.
- `mutation.ts` governs explicit item writes from persisted user turns.
- `archive.ts` governs forget/archive and suppression creation.
- `context-budget.ts` selects a deterministic token-bounded item snapshot and
  renders a small model-facing Markdown view.
- `src/server/agent/context-assembler.ts` assembles each model request inside a
  65,536-token operational envelope, with a configurable burst up to 131,072
  tokens. It measures system/time, tool schemas, current turn, memory,
  continuity, retrieval, and recent raw units without logging prompt content.
- `src/server/agent/token-budget.ts` provides provider/model-labelled local
  estimates. It uses a conservative fallback until an exact tokenizer is
  confidently matched; no paid tokenizer or network call is made.
- Message estimates and tokenizer metadata are persisted on raw messages.
  Request ledgers and provider usage/calibration numbers are persisted on agent
  runs.
- `consolidation.ts` retains a bounded leased job seam for a later background
  synthesizer; proposal payloads are structured, suppression-checked, and
  source-validated.

No token compaction, Dreaming synthesis, deterministic historical preflight,
temporary chat, or memory settings are implemented in this slice. The old
message-count compaction enqueue is paused until the token-based checkpoint
worker is implemented.

## Migration/reset

The Milestone 3 migrations are intentionally rewritten for pre-production. A
local database created from the old memory migrations must be reset before
applying them. Raw chat history can be preserved separately if needed; old
canonical document tables are not compatibility authorities.

The default runtime remains low-cost: semantic search/indexing and background
workers are opt-in. Ordinary chat does not make an embedding or consolidation
model call.
