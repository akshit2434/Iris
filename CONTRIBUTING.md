# Contributing to Iris

Iris is maintained by one developer. The workflow is intentionally lightweight and keeps `main` usable.

## Normal change flow

1. Make one focused change and commit it with a conventional prefix.
2. For small, reversible work, commit directly to `main`.
3. For major features, risky schema changes, or parallel work, create a meaningful branch such as `feature/<short-kebab-description>`, `fix/<short-kebab-description>`, `docs/<short-kebab-description>`, `refactor/<short-kebab-description>`, `test/<short-kebab-description>`, or `chore/<short-kebab-description>`, and use a pull request.
4. Before each commit, run `npm run check:secrets`, `npm run check:privacy`, `npm run lint`, `npm run typecheck`, and `npm run build`.
5. Review the diff before pushing. Squash-merge branches and delete them once finished.

Hosted GitHub Actions CI is temporarily paused. Local checks remain required; restore the workflow when hosted runner access is available again.

## Commit format

Use short imperative commits such as:

```text
feat: add thread continuity boundary
fix: scope message lookup by profile
docs: clarify local Supabase setup
chore: update quality workflow
```

## Scope rules

- Keep Milestone 1 work separate from later memory, accountability, tools, skills, voice, and telemetry work.
- Do not hardcode personal seed context into application logic.
- Do not commit secrets, local database files, private exports, telemetry, or raw user conversations.
- Preserve raw history when adding future summaries or compaction.
- Keep personal names and private context in ignored local files or private service configuration, never in source or Git history.
