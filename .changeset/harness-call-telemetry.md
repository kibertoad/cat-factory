---
'@cat-factory/executor-harness': minor
'@cat-factory/kernel': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Record per-call LLM telemetry for the Claude Code and Codex subscription harnesses,
so their calls appear in the same `llm_call_metrics` store (and the "Model activity"
observability panel) as the proxy-metered Pi harness.

These harnesses talk direct to the vendor and bypass the LLM proxy, so the harness now
lifts per-call metrics off each CLI's event stream: Claude Code (`stream-json --verbose`)
carries full request/response bodies, per-turn tokens, model, and finish reason; Codex
(`exec --json`) is thinner — flat assistant text plus per-turn token counts, with no
request transcript (a CLI limitation). The executor records these into the SAME
`LlmObservabilityService` the proxy uses (with zero per-HTTP timing, since the CLIs don't
expose it), wired symmetrically on the Cloudflare and Node facades. Captured bodies are
credential-scrubbed and honour the existing `LLM_RECORD_PROMPTS` switch.

Bumps the executor-harness runner image (harness `src/**` changed).
