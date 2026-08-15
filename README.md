# Iris

Iris is a conversation-first personal agent with isolated profiles, chats, and history as the base for future memory, tools, skills, reminders, artifacts, voice, and telemetry.

This repository currently implements **Milestone 1: UI + Base**.

## What is included

- Next.js App Router, TypeScript, and Tailwind CSS
- Installable PWA basics: manifest, service worker, and app icons
- Private app PIN gate
- Exactly two locally persisted profiles
- Profile-scoped Supabase Postgres persistence
- Chat creation, history, titles, rename, timestamps, and stable UUIDs
- Raw user and assistant message persistence owned by Iris
- Streaming LangChain agent responses through OpenRouter
- Simple responsive Home, Chat, History, and Files surfaces
- Reserved module boundaries for memory, tools, skills, reminders, artifacts, and telemetry

## Quick start

Requirements: Node.js 20.9+ and a Supabase project.

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Before using chats, run the migration in `supabase/migrations/20260815000000_initial.sql` through the Supabase SQL editor or Supabase CLI.

After the migration, set the two display names directly in the private `profiles` table. Names are runtime configuration and are never committed to this repository.

## Environment

```env
IRIS_APP_PIN=replace-with-a-private-pin
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-server-only-service-role-key
OPENROUTER_API_KEY=your-server-only-openrouter-key
OPENROUTER_MODEL=openai/gpt-5.6-luna
```

`SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY` are server-only. Do not rename them with `NEXT_PUBLIC_` or expose them to browser code.

The model defaults to `openai/gpt-5.6-luna` when `OPENROUTER_MODEL` is omitted.

## Development commands

```bash
npm run dev       # local development
npm run lint      # ESLint
npm run typecheck # TypeScript
npm run build     # production build
npm run start     # run the production build
npm run check:secrets # scan tracked files for credential-like content
```

Repository workflow is documented in [AGENTS.md](AGENTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), and [PUBLIC_REPOSITORY_POLICY.md](PUBLIC_REPOSITORY_POLICY.md).

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

## Intentionally deferred

Full memory consolidation and retrieval, long-thread compaction, external tools/connectors, reminders, personalized skills, artifact generation/storage, voice, telemetry, and full user authentication belong to later milestones. The current base is designed so those capabilities can be added without replacing the chat UI or raw-history store.
