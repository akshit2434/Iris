# Voice transcription

The chat composer uses push-to-talk recording and AssemblyAI's asynchronous pre-recorded transcription API. A browser recording is uploaded only for the duration of the provider job; Iris stores the profile-scoped job state and returned text, then requests provider-side transcript deletion after completion or failure.

The request includes Hindi/English code-switching guidance, bounded normal-sensitivity memory context, up to 1,000 memory and learned vocabulary keyterms, and the current composer context. Sensitive and highly sensitive memory items are excluded from provider hints.

When a user edits dictated text before sending it, the difference is scanned for likely proper nouns, technical terms, numbers, and Indic-script terms. Those terms are stored in `voice_vocabulary`, separate from governed personal memory, and reused on future transcriptions. Ordinary prose is not learned.

The public API is profile- and app-gated: `POST /api/transcribe` starts a job, `GET /api/transcribe/:id` polls it, `DELETE /api/transcribe/:id` cancels an active job, and `POST /api/transcribe/learn` records explicit correction signals from the composer. Recording duration is enforced in the browser: the recorder stops automatically at ten minutes, while the server does not impose an arbitrary byte-size rejection.

## Future latency phase

For near-instant dictation, migrate the composer to AssemblyAI Universal-3 Pro Streaming: mint a short-lived token server-side, stream 16 kHz mono PCM16 from an `AudioWorklet`, replace partial turns instead of appending them, and commit only final turns. Start and terminate each WebSocket with the recording so idle session time is not billed. Keep this async API as the compatibility and recovery path, and validate Hindi-English code-switching with a small representative audio set before making streaming the default.
