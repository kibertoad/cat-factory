---
"@cat-factory/executor-harness": patch
---

Bump the bundled coding-agent CLIs in the executor-harness image (image tag
1.27.0 -> 1.27.1): Pi `0.79.8 -> 0.80.3`, Claude Code `2.1.195 -> 2.1.197`
and Codex `0.142.3 -> 0.142.4`. Routine upstream updates; no harness code
changes. The matching image tag is bumped in `deploy/backend` (`wrangler.toml`
+ the `image:publish` script).
