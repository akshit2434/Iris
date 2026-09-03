# Memory worker and background-operation reliability

**Goal:** Ensure governed memory, reference history, and accountability maintenance actually run in a deployed environment, remain bounded in cost/latency, and provide enough observability to trust the personal-agent experience.

**Proposed branch:** `chore/background-worker-reliability`

## Product decisions

- Chat turns enqueue work; they do not depend on external workers to finish successfully.
- Supabase Cron invokes the internal worker adapter with a secret stored in Supabase Vault. The scheduler is an operational dependency, declared in a migration and verified before release.
- Each job remains idempotent, lease-based, profile-scoped, retry-bounded, and observable without storing raw personal prompts in logs.
- Fast-lane durable facts may remain inline only within a strict time budget; slow synthesis must occur asynchronously.
- Health reporting distinguishes a disabled optional feature from a failing configured worker.

## Implementation steps

1. Choose and document the supported deployment scheduler for the current host. Add its configuration to the repository or deployment runbook, including frequency, worker secret setup, timeout, and authentication. Avoid a hidden manual cron dependency.
2. Schedule `/api/internal/memory/consolidate` at an interval appropriate for queue latency and `/api/internal/accountability/sweep` at a tighter delivery interval. Configure overlap safely; existing claims/leases remain the concurrency boundary.
3. Add an authenticated internal status endpoint/query exposing aggregate job age, queue depth, last success, and terminal failure count per subsystem. Never include message content, memory contents, or provider responses.
4. Add a startup/deployment verification script that checks required worker secrets, scheduler configuration presence, endpoint authentication, and a dry-run/status response. It must not create real personal reminders or memories.
5. Define retry and degraded-mode policy: backoff on provider failures; leave last valid reference history active; retain lexical memory fallback; keep due accountability checks pending until delivered; surface health only after a defined failure/age threshold.
6. Move long-running noncritical fast-lane consolidation out of the interactive completion path if it exceeds the strict latency budget. Preserve explicit `memory_patch` writes as synchronous and authoritative.
7. Add contract and optional local-Supabase acceptance tests covering enqueue → scheduled worker → completed/failed/retry, expired leases, disabled controls, and privacy-safe health responses.

## Acceptance criteria

- A normal deployed environment has a documented, version-controlled worker trigger rather than an assumed manual cron.
- Queued reference history and consolidation work completes within the chosen bounded latency, or exposes a recoverable degraded state.
- Due checks can be delivered while the app is closed, independently of a later chat turn.
- Provider/job failures preserve raw history and current canonical memory, never cross profiles, and do not silently masquerade as an empty state.

## Non-goals

- Introducing a general-purpose queue platform before current database leases prove insufficient.
- Continuous model polling.
- Calendar/Classroom/location workers.
