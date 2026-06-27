---
'@cat-factory/executor-harness': patch
---

Bump the bundled subscription-mode CLIs in the executor-harness image (image tag
1.18.0 -> 1.19.0): Claude Code `2.1.193 -> 2.1.195` and Codex `0.142.2 -> 0.142.3`.
Routine upstream patch updates; no harness code changes. The matching image tag is
bumped in `deploy/backend` (`wrangler.toml` + the `image:publish` script).
