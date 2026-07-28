# Prompt caching — capability, surfacing, and the open provider questions

A container agent (Pi) re-sends its **whole growing prompt every turn**, so on a
provider that caches the stable prefix, each turn is a cache hit instead of a re-billed,
re-processed input. Caching's value here is **latency and throughput** (faster, less
rate-limited multi-turn runs), not cost — token burn is not a concern for this project.

## Single source of truth

`providerCachePolicy(provider)` (`@cat-factory/kernel`, `domain/cache-policy.ts`) is the
one place that classifies how a provider caches:

| Policy               | Providers                                                           | How                                                                                                 |
| -------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `auto-prefix`        | `openai`, `deepseek`, `qwen`                                        | caches automatically on an exact prefix match; OpenAI also accepts a `prompt_cache_key` routing key |
| `explicit-anthropic` | `anthropic`                                                         | needs explicit `cache_control` breakpoints (set on the inline path)                                 |
| `none`               | `workers-ai`, `moonshot`, `openrouter`, `litellm`, bedrock, unknown | no caching we rely on                                                                               |

`providerCachesPrompts(provider)` is the boolean derived from it. Both the model catalog
(`models.ts` `toOption` → `ModelOption.cachesPrompts`) and the AI-call helpers
(`@cat-factory/agents` `cache.ts`, which re-exports the kernel policy) read it, so the
classification is never hard-coded twice.

## The hot path runs cache-less

The shipped per-kind defaults all run on **Workers AI** (`coder`→Kimi, `architect`/
`reviewer`→GLM, `conflict-resolver`→Kimi, unpinned→Qwen), whose policy is `none`. A
workspace upgrades a model to a caching route by **connecting a direct key** (Qwen /
DeepSeek / OpenAI), which flips that model's effective flavour `cloudflare → direct`
(`auto-prefix`). This is now **visible** rather than invisible:

- the model picker shows a `Prompt caching` / `No prompt caching` badge per flavour
  (`ModelConfigurationPanel.vue`, via `cachingBadge` in `stores/models.ts`);
- the API-keys panel notes which direct keys enable caching (`ApiKeysSection.vue`);
- the step metrics bar leads with TOTAL input (fresh + both cache classes, `totalInputTokens` —
  the like-for-like of Claude Code's context gauge) and shows the three classes as its breakdown,
  and the per-agent-kind summary carries `cacheReadTokens` + `cacheWriteTokens` as two distinct
  sums plus a derived `cacheHitRate` (`StepMetricsBar.vue`, `observability.logic.ts`, both
  repositories). Splitting the classes is about making cost readable — it must never be allowed
  to shrink the headline VOLUME, which is what a cache-dominated agentic run actually burns.

We deliberately **do not auto-flip the shipped model defaults** — that's a model-quality
decision that needs benchmark evidence (below), not a blind change.

### Reading the hit rate

The three input classes are **orthogonal**: `promptTokens` is FRESH input only, and
`cacheReadTokens` / `cacheWriteTokens` sit beside it, so the total input a call processed is
their sum. `cacheHitRate = (read + write) / (fresh + read + write)` — a genuine 0..1 share
that needs **no clamp**. (It used to be `cached / prompt` clamped to 1, because on the
Anthropic shape `promptTokens` never contained the reads and the ratio could exceed 1. That
clamp is gone with the denominator it was papering over.)

Two functions reconcile the provider shapes at the recording sites:

- **`cacheTokensFromUsage`** returns `{ read, write }`, reading the classes APART across the
  field names providers use: OpenAI (`prompt_tokens_details.cached_tokens`), DeepSeek
  (`prompt_cache_hit_tokens`), Anthropic (`cache_read_input_tokens` +
  `cache_creation_input_tokens`, and the AI SDK's camelCase spellings). Only Anthropic exposes
  a write class; on the others `write` is 0 rather than guessed. Keeping them apart is not
  cosmetic either: a read costs ~0.1x base input while a **write costs 1.25-2x — more than
  fresh** — so summed together, a loop that keeps invalidating and re-writing the prefix is
  indistinguishable from one riding a warm cache.
- **`freshPromptTokens`** normalises the prompt count to the fresh figure. For **`auto-prefix`**
  providers (OpenAI/DeepSeek/Qwen) the cached count is a true SUBSET of the reported prompt
  tokens, so it is subtracted (clamped at 0); for **Anthropic** (`explicit-anthropic`)
  `input_tokens` is already exclusive of both classes, so nothing comes off. That is what makes
  the inline Anthropic path — which opts in via `inlineCacheProviderOptions` — actually
  measured, rather than silently reported as `0`.

## Open questions — providers currently `none` that may cache

`cacheTokensFromUsage` already attributes cached tokens for **any** provider that
reports them (the proxy calls it unconditionally), so promoting a provider in
`providerCachePolicy` changes only (a) the request hint for a key-routed provider and
(b) the `cachesPrompts` capability the UI advertises. We keep these at `none` until a run
demonstrably reports `cacheReadTokens > 0`, so the UI never advertises caching a
provider doesn't actually deliver:

- **`moonshot` (direct Kimi)** — Moonshot documents context caching; unverified whether
  its OpenAI-compatible chat endpoint returns cached-token usage automatically.
- **`openrouter`** — a gateway that can pass through the underlying provider's caching
  and a `cache_discount`; behaviour is per-underlying-model.
- **`litellm`** — an operator-hosted gateway; pass-through depends on its config.

### How to verify (and then promote)

The benchmark harness measures this directly. `RunnerOutput.usage.cachedInputTokens`
flows through to the report's **Cache hit** column (`report.ts`), and
`bench.config.example.ts` carries a caching dimension: route the **same model** through a
candidate provider vs the cache-less Workers-AI flavour on a repeated-prefix task. A
provider "caches" iff its cell reports a non-zero cache-hit rate. When a provider is
confirmed, add it to `providerCachePolicy` (`auto-prefix`, plus a routing key in
`promptCacheParams` if it needs one) and extend `provider-cache.spec.ts`. Until then the
honest default — and the honest UI badge — is `No prompt caching`.

The **Cache hit** column is only populated by the AI-SDK-backed runners that report
token usage (`requirementReview`, `codeReview` — anything whose `usage` carries
`cachedInputTokens`). The **`implementation`** runner drives the real **Pi** harness,
which doesn't surface per-call SDK usage, so its cells render `—` (no data) rather than
`0%` (cache-less). Read a Pi `—` as "not measured here", not "caching broken" — the Pi
caching path is exercised in production, not in this report.
