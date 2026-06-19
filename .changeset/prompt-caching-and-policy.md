---
'@cat-factory/agents': minor
'@cat-factory/kernel': minor
'@cat-factory/contracts': minor
'@cat-factory/orchestration': patch
'@cat-factory/server': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/app': patch
---

Add prompt caching for container-agent model calls, plus the observability to prove
it works, and unify how both AI-call paths treat a provider's cache.

- **Shared cache policy** (`@cat-factory/agents`): `providerCachePolicy` is the single
  source of truth for how each provider caches (`auto-prefix` for OpenAI/DeepSeek/Qwen,
  `explicit-anthropic`, or `none`). Both the in-container proxy path and the inline
  AI-SDK path consult it instead of hard-coding provider ids.
- **Proxy** (`@cat-factory/server`): routes a run's calls to the same cached prefix via
  `prompt_cache_key` (keyed on the execution id) on providers that support it — the big
  win, since a container agent re-sends its whole growing prefix every turn. It also
  fixes the misleading `requestMaxTokens` metric to record the EFFECTIVE output ceiling
  (it previously logged the client's value before the Workers-AI floor override, so it
  read as `null`).
- **Measure the hit rate**: `LlmCallMetric` gains `cachedPromptTokens` (read across the
  `prompt_tokens_details.cached_tokens` / `prompt_cache_hit_tokens` field names), so the
  dashboard shows cached vs total prompt tokens per call. D1 migration `0028` + a Drizzle
  migration add the column.

Note: the inline path's calls are single-shot (no growing prefix), so caching there is
marginal; full inline-call observability (recording inline LLM calls through the same
sink) is a follow-up.
