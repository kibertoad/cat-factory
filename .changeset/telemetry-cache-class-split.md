---
'@cat-factory/executor-harness': minor
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/integrations': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/observability-langfuse': minor
'@cat-factory/observability-otel': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/local-server': minor
'@cat-factory/app': minor
---

Make the three LLM input-token classes orthogonal in telemetry: `promptTokens` is now FRESH
(uncached) input only, with `cacheReadTokens` and `cacheWriteTokens` carried beside it, so total
input is their sum. A cache read is priced ~0.1x base input and a cache write 1.25-2x, so the old
lumped `cachedPromptTokens` made a run re-writing its prefix every turn indistinguishable from one
riding a warm cache.

BREAKING (telemetry only, no migration path by design): `cachedPromptTokens` is dropped from
`llmCallMetricSchema`, `llmCallActivitySchema`, `stepMetricsSchema` and the metrics export, and
`cached_prompt_tokens` is dropped from both telemetry stores. `HarnessCallMetric.cachedInputTokens`
becomes `cacheReadTokens` + `cacheWriteTokens`, and `inlineResult.usage` gains the same split.
`llm_call_metrics` is pruned to a 3-day window, so rows carrying the old inclusive `prompt_tokens`
semantics churn out on their own; `cacheHitRate` is now `(read + write) / (fresh + read + write)`
and no longer needs its clamp. `cachedTokensFromUsage` is replaced by `readInputTokenClasses`,
which returns all three classes from one usage payload (reconciling the inclusive and exclusive
provider shapes internally, so no caller has to know which it is holding), and
`ProxyCallObservation.cachedPromptTokens` becomes `inputTokens: InputTokenClasses`.
