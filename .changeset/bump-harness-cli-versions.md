---
'@cat-factory/executor-harness': patch
---

Bump the bundled coding-agent CLIs in the executor-harness image (image tag
1.34.0 -> 1.34.1): Claude Code `2.1.197 -> 2.1.199` and Codex `0.142.4 ->
0.142.5`. Pi stays at `0.80.3` (already the latest release). Routine upstream
updates; no harness code changes. The matching image tag is bumped in
`deploy/backend` (`wrangler.toml` + the `image:publish` script) and in
`RECOMMENDED_HARNESS_IMAGE` (`backend/runtimes/local/src/harnessImage.ts`).
