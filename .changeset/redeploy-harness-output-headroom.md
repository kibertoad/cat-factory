---
'@cat-factory/executor-harness': patch
---

Re-tag the runner image 1.5.0 → 1.6.0 to force a rollout of the 32k output headroom.

The `PI_MAX_OUTPUT_TOKENS` 16k → 32k bump (see harness-output-headroom-and-guards)
landed in source under the existing 1.5.0 tag, so the deployed container kept running
the stale 16k digest — `wrangler deploy` diffs the image by tag string and reports
"no changes" when the tag is reused. Production telemetry confirmed it: every
spec-writer LLM call recorded `request_max_tokens: 16384`, and one completion hit that
ceiling exactly. A fresh, immutable tag is what forces the new digest to roll out.

Bumps the runner image tag to 1.6.0 (deploy/backend `image:publish` + wrangler.toml).
