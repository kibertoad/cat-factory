---
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Make recording of complete prompts in LLM observability optional, governed by a new
`LLM_RECORD_PROMPTS` environment variable.

The LLM observability sink keeps the full prompt sent to the model with each metric.
That prompt text can contain sensitive content (source, secrets), so some deployments
must not retain it. `LlmObservabilityService` now takes a `recordPrompts` flag (default
true, preserving current behaviour); when it is false the numeric telemetry (tokens,
timing, finish reason, message/tool counts) is still recorded but the prompt body is
stored empty and the delta-chain read is skipped entirely.

- New `ObservabilityConfig.recordPrompts` on the shared `AppConfig` contract, threaded
  through `CoreDependencies.recordLlmPrompts` into the service.
- Both runtime facades read `LLM_RECORD_PROMPTS` (any value other than `false` keeps
  recording on): the Cloudflare Worker via a new `loadObservabilityConfig`, the Node
  service via `loadNodeConfig`. Documented in `deploy/backend/wrangler.toml` and
  `deploy/node/.env.example`.
