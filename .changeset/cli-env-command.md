---
'@cat-factory/cli': minor
---

Add a `cat-factory env` command that generates ONLY a ready-to-run local-mode `.env` in the
current directory (or `--dir`) — the same secret generation, GitHub/GitLab PAT browser flow, and
pool-vs-native execution-mode choice as `init`, but without scaffolding a whole project. Use it in
an existing deployment dir (e.g. `deploy/local`).

Also generate the `HARNESS_SHARED_SECRET` (the backend↔executor-harness HMAC key) alongside
`AUTH_SESSION_SECRET` and `ENCRYPTION_KEY`, and write it into the local `.env` (and `.env.example`).
It is required to boot, so both `init` and `env` now produce a `.env` that runs local mode with no
manual edits (a model-provider key is not needed to boot — add providers/keys in the UI).
