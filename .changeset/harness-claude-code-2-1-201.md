---
'@cat-factory/executor-harness': patch
---

Bump the bundled Claude Code CLI to `2.1.201` in the runner image. Codex stays
at `0.142.5` (already the latest within the release-age window). Also bump
`@hono/node-server` to `^2.0.8` to keep the workspace on a single version. The
harness image tag and its pins (`deploy/backend`, `RECOMMENDED_HARNESS_IMAGE`)
are bumped to `1.34.11` in step.
