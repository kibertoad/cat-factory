---
'@cat-factory/observability-langfuse': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
---

Add optional, opt-in **Langfuse** LLM observability. A new fetch-based
`@cat-factory/observability-langfuse` package implements a runtime-neutral
`LlmTraceSink` (new kernel port) against Langfuse's ingestion API — no Node SDK or
OpenTelemetry, so it runs unchanged on BOTH the Cloudflare Worker (workerd) and Node
facades.

Proxied container-agent calls and inline (non-proxied) calls — requirements
review/rework, document planner, fragment selector, the inline agent — flow through the
SAME sink path: the orchestration `LlmObservabilityService` fans every recorded proxied
call out as a generation, and an `InstrumentedModelProvider` wraps every resolved model
so inline `generateText` calls surface the identical `LlmGenerationEvent`. Calls are
grouped under one trace per run (`executionId`); inline single-shot calls become their
own standalone trace.

Off unless `LANGFUSE_ENABLED=true` and both keys are set; wired symmetrically in both
runtime containers. Honours the existing `LLM_RECORD_PROMPTS` switch (prompt/response
bodies are omitted from Langfuse too when disabled). The sink never throws into the LLM
path — failures are swallowed and logged. The existing local metric store, spend gating
and board rollups are unchanged; Langfuse is an additive external sink, not a
replacement.
