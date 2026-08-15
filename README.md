# Iris

Iris is a conversation-first personal agent with isolated profiles, chats, and history as the base for future memory, tools, skills, reminders, artifacts, voice, and telemetry.

This repository currently implements **Milestone 2: Agent Runtime** on top of the Milestone 1 UI + Base.

## Current progress

**Stage:** Milestone 2 — Agent Runtime is complete locally on this branch. A controlled live browser smoke verified live streaming, two-turn continuity, both internal tool calls and results, persistence after reload, and profile isolation. Milestone 3 remains deferred.

The public build is a mobile-first, conversation-first base with isolated profiles, persistent raw chat history, local Supabase development, and the visual language documented in [docs/UI_STANDARDS.md](docs/UI_STANDARDS.md).

### UI preview

| Home | Chat |
| --- | --- |
| <img src="docs/screenshots/mobile-home.jpg" alt="Iris mobile home screen" width="260"> | <img src="docs/screenshots/mobile-chat-blur.jpg" alt="Iris mobile chat with progressive edge blur" width="260"> |

These previews use only generic seeded labels and temporary QA copy. No private personal context is included.

## What is included

- Next.js App Router, TypeScript, and Tailwind CSS
- Installable PWA basics: manifest, service worker, and app icons
- Private app PIN gate
- Exactly two locally persisted profiles
- Profile-scoped Supabase Postgres persistence
- Chat creation, history, titles, rename, timestamps, and stable UUIDs
- First-turn automatic chat titles use one additional small provider request;
  `OPENROUTER_TITLE_MODEL` can override the title model and defaults to the
  configured `OPENROUTER_MODEL`. Title generation never delays first-token
  streaming and falls back locally if it fails.
- Raw user and assistant message persistence owned by Iris
- Streaming LangChain agent responses through OpenRouter
- Versioned NDJSON run events with persisted, profile/thread-scoped tool activity
- Simple responsive Home, Chat, History, and Files surfaces
- Mobile-first visual system with generated Iris artwork, restrained copy, and procedural edge blur
- Local Supabase CLI workflow with a safe public seed (`Profile A` / `Profile B`)
- Reserved module boundaries for memory, tools, skills, reminders, artifacts, and telemetry

## Quick start

Requirements: Node.js 20.9+, Docker, and the Supabase CLI.

```bash
npm install
supabase start
supabase db reset
supabase status -o env
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`supabase db reset` applies the migration and safe public seed. Use `supabase status -o env` to get the local API URL and server-only service-role key for `.env.local`; do not commit `.env.local`.

For a hosted environment, replace the local Supabase values with the private project URL and service-role key. Personal display names are runtime database configuration and are never committed to this repository.

## Environment

```env
IRIS_APP_PIN=replace-with-a-private-pin
SUPABASE_URL=http://127.0.0.1:56321
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
OPENROUTER_API_KEY=your-server-only-openrouter-key
OPENROUTER_MODEL=openai/gpt-5.6-luna
# Optional; defaults to OPENROUTER_MODEL for the one small first-turn title request.
# OPENROUTER_TITLE_MODEL=openai/gpt-5.6-luna
# Optional development tracing (keep disabled unless a private tracing project is configured).
LANGCHAIN_TRACING_V2=false
# LANGCHAIN_API_KEY=your-server-only-langsmith-key
# LANGCHAIN_PROJECT=iris-development
```

`SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY` are server-only. Do not rename them with `NEXT_PUBLIC_` or expose them to browser code.

The model defaults to `openai/gpt-5.6-luna` when `OPENROUTER_MODEL` is omitted.

Automated tests use deterministic LangChain fake models and never call OpenRouter or another live model. The controlled live browser smoke is a separate verification step; no live provider credentials are needed for the repository test suite.

## Development commands

```bash
npm run dev       # local development
npm test          # deterministic runtime and stream tests; no network/model calls
npm run lint      # ESLint
npm run typecheck # TypeScript
npm run build     # production build
npm run start     # run the production build
npm run check:secrets # scan tracked files for credential-like content
```

Repository workflow is documented in [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [PUBLIC_REPOSITORY_POLICY.md](PUBLIC_REPOSITORY_POLICY.md).

The mobile-first visual and interaction rules are documented in [docs/UI_STANDARDS.md](docs/UI_STANDARDS.md).

## Data and privacy

Profiles are separate namespaces. Server routes derive the active profile from an HTTP-only profile cookie; database queries include `profile_id`, and the schema enforces matching profile/thread ownership with composite foreign keys. Row Level Security is enabled on the core tables.

Raw messages are stored in Iris's database as canonical history. Future summaries, retrieval indexes, pinned context, and memory revisions must never replace or delete that raw history.

## Project shape

```text
app/                         Next.js routes, pages, API handlers
src/components/              Responsive Iris UI
src/server/agent/             LangChain + OpenRouter boundary
src/server/db/                Server-only Supabase client and queries
src/server/{memory,tools,...} Future milestone boundaries
supabase/migrations/          Database schema
```

Private product context and visual references are intentionally local-only and excluded from Git.

## Next stage

Milestone 3 — Memory is next. The runtime keeps raw messages canonical and leaves memory consolidation, retrieval, and compaction for that milestone.

Memory, tools, skills, reminders, artifacts, voice, telemetry, and full authentication remain deferred to their later milestones.

## Intentionally deferred

Full memory consolidation and retrieval, long-thread compaction, external tools/connectors, reminders, personalized skills, artifact generation/storage, voice, telemetry, and full user authentication belong to later milestones. The current base is designed so those capabilities can be added without replacing the chat UI or raw-history store.
