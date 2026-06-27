---
'@cat-factory/contracts': minor
'@cat-factory/kernel': minor
'@cat-factory/agents': minor
'@cat-factory/orchestration': minor
'@cat-factory/server': minor
'@cat-factory/app': minor
'@cat-factory/worker': minor
'@cat-factory/node-server': minor
'@cat-factory/executor-harness': patch
---

Make prompt-caching a first-class, visible capability and add per-kind progress-guard
leniency.

**Caching capability + observability.** `providerCachePolicy` moves to the kernel
(`domain/cache-policy.ts`, re-exported from `@cat-factory/agents`) so the model catalog
can derive a per-flavour `ModelOption.cachesPrompts` from the effective provider — the
same model reads `false` on its cache-less Cloudflare/Workers-AI flavour and `true` once
a direct key upgrades it to its caching `direct` flavour. The already-recorded
`cachedPromptTokens` is now aggregated per agent kind in `summarizeByExecution` (D1 +
Drizzle, kept symmetric) and surfaced as `cachedPromptTokens` + a derived `cacheHitRate`
on the step rollup and the LLM-metrics export.

**Vendor-selection UI.** The model picker shows a `Prompt caching` / `No prompt caching`
badge per flavour, the API-keys panel notes which direct keys enable caching, and the
step metrics bar shows a cached-token split when present — so a user can see (and act on)
the hot path running cache-less. Shipped model defaults are intentionally NOT changed;
extending `providerCachePolicy` to more providers (Moonshot / OpenRouter / LiteLLM) is
gated on benchmark evidence (see `backend/docs/prompt-caching.md`).

**Per-kind guard leniency.** The container progress guard can now be loosened per agent
kind via an optional `guardLimits` job-body field (clamped per knob in the harness;
merged over the env/built-in defaults — loosen-only, never tighten). A data-driven
`agentTuningFor` seam (`@cat-factory/agents`, plus an `AgentKindDefinition.tuning` hook
for custom kinds) supplies the profile, which `ContainerAgentExecutor` folds into the
dispatch body. Initial profiles give `conflict-resolver` more error headroom and the
research-heavy kinds a higher consecutive-web cap, so a legitimately-progressing run is
not killed for its normal pattern. Output-token ceilings are unchanged.
