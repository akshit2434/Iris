# Cold-start relationship onboarding

**Goal:** A new or memory-sparse profile should feel met as a person, not as an empty chat. Iris learns gradually in conversation without blocking a concrete request or presenting a setup form.

**Proposed branch:** `feature/cold-start-onboarding`

## Product decisions

- Trigger only for a persistent profile with no completed onboarding, no meaningful saved memory, and very little user-authored history. Temporary chats never trigger it.
- A greeting or other open-ended message gets one warm, context-seeking question. A specific request is answered first; Iris may ask one relevant follow-up afterward.
- Onboarding is progressive: never ask a survey, never request more than one answer per turn, always allow “not now”.
- Learn only information that has future value. Each stable answer is saved through the existing governed `memory_patch` path, not through a parallel profile blob.
- Store lightweight progress and consent state separately from durable memories: `not_started`, `in_progress`, `complete`, `deferred`; opted-in accountability tone; and a confirmed IANA timezone. Do not pre-fill private seed facts.
- The relationship target is warm, curious, candid companionship. Do not hard-code a romantic role or simulate dependency; tone remains profile-scoped and user-controllable.

## Initial conversation map

1. Welcome and ask what is taking up the person’s life or headspace now.
2. Learn their current priorities/responsibilities only as they arise.
3. Ask how direct Iris should be about plans and follow-through.
4. Confirm timezone and later ask notification/quiet-hour preferences only when notifications are available.
5. Mark onboarding complete once Iris has enough basis to be useful; it may reopen a focused question later when a relevant gap blocks good help.

## Implementation steps

1. Add an `onboarding_profiles` table keyed by `profile_id`, with lifecycle state, deferred timestamp, confirmed timezone, accountability-tone preference, and timestamps. Apply the existing RLS/service-role conventions; do not store free-form biography there.
2. Add a small server repository and a pure `onboarding` domain module that determines eligibility from lifecycle state, saved-memory count, and user-message count. Its decisions must be deterministic and independently tested.
3. Load the resulting onboarding snapshot with the normal turn context. Extend `AgentContext` and the dynamic prompt with a narrowly scoped policy: one question maximum, no questionnaire, specific requests first, durable facts saved with `memory_patch`, defer respected.
4. Add a small `onboarding_update` internal tool. It can mark progress, defer, set a confirmed timezone, and store a consented tone preference. It cannot write biography or memories.
5. Add a compact non-dashboard UI cue only when an onboarding question is pending; do not add a wizard, profile form, or progress percentage. The cue should be dismissible and should route into chat.
6. Add test fixtures for zero-memory/new-history, partial onboarding, deferred onboarding, specific requests, temporary chats, and cross-profile isolation.

## Acceptance criteria

- A new profile saying “hi” receives one natural getting-to-know-you question.
- A new profile asking “help me write this email” gets the email help immediately, without being blocked by onboarding.
- A stable answer such as a current role or preference is saved through a real `memory_patch` tool result.
- “Not now” stops proactive onboarding questions until an explicit re-entry condition, not merely the next turn.
- Existing profiles with meaningful memory are unaffected.

## Non-goals

- Importing personal context from another profile.
- A long initial form, personality test, or forced notification permission prompt.
- Calendar, telemetry, or external integrations.

