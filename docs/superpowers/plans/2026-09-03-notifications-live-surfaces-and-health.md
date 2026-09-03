# Notifications, live surfaces, and accountability health

**Goal:** Make delivered accountability work visible at the right time, both while Iris is open and when it is closed, while giving the user understandable control and making system failure recoverable rather than silent.

**Proposed branch:** `feature/accountability-notifications-health`

## Product decisions

- In-app delivery is the baseline; Web Push is additive and permissioned.
- Push is sent only after the database delivery is committed. Push failure never changes loop/check state.
- Notification copy is deterministic by default and contains no sensitive content on a locked screen unless the person has explicitly opted into detailed previews.
- Quiet hours, notification strength, and previews are per-profile preferences with practical defaults. No large settings matrix.
- The app uses realtime database subscriptions or a short foreground refresh on visibility/focus. It does not poll an LLM.
- Health is private, concise, and recovery-oriented: the user sees a small status only when a promised delivery channel has been unavailable or needs action.

## Phase A — live in-app delivery

1. Add a profile-scoped realtime subscription for new assistant check-in messages and delivery-state changes, or a focused visibility/focus refresh if realtime is not suitable for the current deployment.
2. When the selected/visible thread receives a delivery, append it into the transcript and load matching quick actions without a full navigation reload.
3. When another thread receives one, update Home attention and show a restrained in-app indicator that routes to the relevant check-in.
4. Add browser tests for a currently open chat, Home, and a delivery written to a different thread.

## Phase B — Push subscription and sending

1. Add a `push_subscriptions` table scoped to `profile_id` and device/browser identity. Store endpoint, encryption keys, user-agent metadata, permission state, failure timestamps, and revoked state. Encrypt or otherwise protect only what is necessary.
2. Add server routes to register, revoke, and inspect the active profile’s subscription. Validate payload size and scope; a browser can only manage its selected profile.
3. Extend the service worker with `push` and `notificationclick` handlers. A notification click deep-links to the exact delivery thread/message; no credentials or private text are put in the URL.
4. Add a small browser permission affordance only after the user has experienced useful in-app accountability. Explain the benefit and allow dismissal. Never request permission on first render or during cold-start onboarding.
5. After a committed delivery, enqueue/send Push subject to preference, quiet hours, and notification-strength policy. Handle expired endpoints by marking the subscription revoked and falling back to in-app delivery.
6. Verify through service-worker/unit contracts and an opt-in real-browser acceptance path; do not claim native alarm/vibration behavior that a PWA cannot guarantee.

## Phase C — preferences and health

1. Add a compact profile preference model: notifications enabled, preview level, quiet-hours range, and preferred salience. Use a local-time policy and documented behavior across daylight-saving changes.
2. Add a `delivery_health` projection or equivalent query for: last successful worker sweep, oldest due-but-undelivered check, active Push availability, and the last terminal worker/push failure code. Keep raw error details server-only.
3. Show a low-emphasis Home/Profile recovery cue only when action is needed, such as “Notifications are off” or “Iris could not deliver follow-ups recently.” Include one actionable route; do not show permanent status chrome.
4. Add operational logs/metrics for delivery latency, duplicate prevention, Push success/failure, and health-state changes without logging message content.

## Acceptance criteria

- A check-in written while the app is open appears without a page reload.
- A permitted device receives one push for one committed delivery and opens the correct chat on tap.
- Quiet hours suppress Push while retaining in-app delivery and deferred/recovery behavior.
- Push failure never loses or duplicates a database delivery.
- A real delivery outage becomes visible to the profile without exposing private data or stack traces.

## Non-goals

- Native Android alarm semantics.
- Email/SMS fallback channels.
- Cross-profile or cross-person notification sharing.

