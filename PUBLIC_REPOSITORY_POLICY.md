# Public repository policy

This repository is public source code. It must never contain personal context, private user data, credentials, or copied assets without confirmed redistribution rights.

Keep private material in ignored local directories such as `.private/` or `iris_context_pack/`, and keep runtime data in the database and storage providers. Do not commit database dumps, transcripts, memories, uploads, exports, telemetry, logs, or environment files.

Run `npm run setup:git` once after cloning. The local hook runs privacy and credential checks on staged files. For additional local protection, add words or phrases that must never enter Git to `.private/privacy-denylist.txt`, one per line.

If sensitive material is ever committed, remove it from the current tree, rewrite Git history or start from a clean public history, and rotate any affected credentials. A later deletion commit does not make prior history safe.
