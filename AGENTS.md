# Iris repository workflow

This file is the operating guide for automated coding work in this repository.

## Before changing code

- Orient with `docs/ARCHITECTURE.md` (system map) and `docs/OPERATIONS.md` (env vars, workers, scheduling) before non-trivial changes.
- If `iris_context_pack/` exists locally, read the relevant files before changing product behavior. It is private local context and must remain untracked.
- Keep implementation inside the current milestone in `BUILD_PLAN.md`.
- Run `git status -sb` first and preserve unrelated work.
- Never stage or commit private names, `.env.local`, service keys, user exports, runtime logs, database dumps, generated private data, or personal context.

## Milestone planning artifacts

- Milestone design specs live in `docs/MILESTONE_*.md`; step-by-step implementation plans live in `docs/superpowers/plans/YYYY-MM-DD-<slug>.md`.
- One short-lived branch per milestone phase (`feature/<phase-slug>`); plans are executed task-by-task with tests green before each commit.
- Update the milestone doc's phase table when a phase lands; refresh README status at milestone completion.

## Branches and commits

- Commit directly to `main` for small, reversible, single-purpose changes. For major features, risky migrations, parallel work, or changes that benefit from an isolated reviewable diff, use a short-lived meaningful branch such as `feature/<short-kebab-description>`, `fix/<short-kebab-description>`, `docs/<short-kebab-description>`, `refactor/<short-kebab-description>`, `test/<short-kebab-description>`, or `chore/<short-kebab-description>`.
- Use focused imperative commits with a conventional prefix: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, or `chore:`.
- Keep commits small enough to explain in one sentence. Do not mix product behavior, formatting churn, and unrelated cleanup.
- Use a pull request only for major, hard-to-revert, or parallel work. Squash-merge it after checks pass.

## Required checks

Before committing or opening a pull request, run:

```bash
npm run check:secrets
npm run check:privacy
npm run lint
npm run typecheck
npm run build
```

For UI changes, inspect the main desktop and mobile flows in a real browser. For database or agent changes, state which live integrations could not be exercised when credentials are unavailable.

## Privacy boundary

This is a public source repository. Private product context stays in ignored local directories; runtime data stays in the database and storage providers. Run `npm run setup:git` once per clone to install the local privacy pre-commit hook. See `PUBLIC_REPOSITORY_POLICY.md`.
