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
- `reference-history.ts` implements the derived cross-chat "Dreaming" layer.
  It produces versioned, rebuildable profile snapshots with structured claims,
  concise rendered text, source thread/message ranges, token watermarks, source
  hashes, and synthesizer versions. It never writes authoritative memory.
  Optional saved-memory candidates pass through the existing consolidation
  validator and an explicit callback before any later governed persistence.
- `reference-history-repository.ts` owns profile-scoped controls and the
  leased reference-history queue. Saved-memory reference and chat-history
  reference are independent controls; stale snapshots are withheld until they
  are rebuilt against current saved-memory revisions.

## Governed lifecycle

- Explicit `memory_patch` writes are synchronous and profile-scoped. Create,
  correction, and restore operations are idempotent, optimistic-revision
  guarded, and linked to the persisted user turn.
- Corrections use a `supersede` mutation and `corrects` provenance relation;
  prior revisions and every source remain immutable.
- Ordinary completed runs enqueue automatic candidates only after a cumulative
  serialized-token watermark or an idle/debounce flush. The enqueue RPC keeps
  the per-thread watermark and prevents duplicate extraction jobs under races.
- Automatic proposals must be inferred, normal-sensitivity, sufficiently
  confident, source-owned, safe, and non-ambiguous. Credentials, one-time
  codes, transient observations, role-play, speculative psychology, and
  sensitive third-party data are rejected before persistence.
- Forget/archive writes a durable suppression keyed by profile, canonical key,
  and content fingerprint. Retained history cannot recreate it until an
  explicit write lifts the suppression. Archived and superseded items never
  enter normal context.

Continuity checkpoints and reference-history synthesis are token-triggered and
worker-driven. Reference-history jobs run after meaningful unprocessed profile
tokens or an idle/debounce signal, never on every turn and never from a
message-count threshold. Incremental jobs use the previous validated snapshot;
rebuild jobs read raw retained history. Failures leave the last valid snapshot
active and retry through the lease queue. Tests inject synthesizers and never
call the provider. Production workers are opt-in through
`MEMORY_CONTINUITY_ENABLED` and `MEMORY_REFERENCE_HISTORY_ENABLED`.

## Migration/reset

The Milestone 3 migrations are intentionally rewritten for pre-production. A
local database created from the old memory migrations must be reset before
applying them. Raw chat history can be preserved separately if needed; old
canonical document tables are not compatibility authorities.

The default runtime remains low-cost: semantic search/indexing and background
workers are opt-in. Ordinary chat does not make an embedding or consolidation
model call.
