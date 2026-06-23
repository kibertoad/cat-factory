---
'@cat-factory/server': patch
---

Raise the workers-ai proxy output floor `PI_MIN_OUTPUT_TOKENS` 16k → 32k — the actual
fix for spec-writer truncation.

The LLM proxy floors every `workers-ai` call to `max_tokens = max(asked, floor)` and
records/applies that. Production telemetry showed all 362 workers-ai calls recording
exactly 16384, never 32768: Pi does not forward its model-entry `maxTokens` (the
harness `PI_MAX_OUTPUT_TOKENS`) as the request `max_tokens`, so `asked` is always at or
below the floor and the floor is the effective ceiling. Bumping the harness ceiling to
32k (and rebuilding the image) therefore had no effect on the applied limit. The proxy
floor is the lever, and it's a worker-side change — no image rebuild needed.
