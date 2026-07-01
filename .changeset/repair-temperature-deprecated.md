---
'@cat-factory/executor-harness': patch
---

Stop sending `temperature` on the structured-output repair call so it works on Anthropic's newest models.

When an agent's final JSON reply didn't parse, the harness made a one-shot "structured repair" call that hard-coded `temperature: 0`. Anthropic's newest models (Opus 4.7+ and the Claude 5 family) have **removed** the sampling parameters and reject any of them with `400 invalid_request_error: temperature is deprecated for this model` — so on Claude Opus 4.8 via the claude-code subscription harness the repair itself failed, and the run died with `Implementation failed: the agent produced no structured result … [structured repair did not help (subscription repair call failed: HTTP 400 …)]`.

The repair prompt already constrains the output to JSON-only, so determinism via `temperature=0` isn't needed. Both repair bodies (the LLM-proxy path and the Anthropic-compatible subscription path) now omit `temperature` entirely, which is valid on every current and future model regardless of provider.
