---
'@cat-factory/executor-harness': minor
---

Bump the bundled subscription harness CLIs to their latest stable releases:
Claude Code `2.0.30` → `2.1.191` and Codex `0.47.0` → `0.142.0` (Pi unchanged).

This changes the runner image contents, so the image tag is bumped to `1.11.0` in
both `deploy/backend/package.json` (`image:publish`) and `deploy/backend/wrangler.toml`
(`[[containers]] image`). Republish + redeploy the managed-registry image to roll it out.
