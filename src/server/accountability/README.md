# Accountability boundary

This module owns the accountability domain: open loops that track commitments made in conversation, scheduled checks that evaluate them, deliveries that surface results back into chat, and suppressions that keep notifications quiet when users opt out. The UX is chat-first — loops are created, updated, and resolved through conversation rather than a dedicated UI — and scoping is person-based rather than thread-based, so a loop follows a person across conversations. See `docs/MILESTONE_4_ACCOUNTABILITY.md` for the milestone spec.
