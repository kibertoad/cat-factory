---
'@cat-factory/executor-harness': patch
---

Update the bundled subscription harnesses to their latest versions: Claude Code
`2.1.191` → `2.1.193` and Codex `0.142.0` → `0.142.2`. These change the runner
image, so the image tag is bumped in `deploy/backend` (`image:publish` +
`wrangler.toml`) accordingly.
