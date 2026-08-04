import type { LlmTokenRates, ModelRef } from '@cat-factory/kernel'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import { costOfTokenClasses } from '@cat-factory/kernel'
import type { OpenRouterModelMeta, WorkspaceSettings } from '@cat-factory/contracts'

// Pricing for the spend safeguard. Token usage is converted to a monetary cost
// so a single, human-meaningful budget ("~100 EUR/month") can gate execution
// regardless of which provider/model a given agent routes to.
//
// Prices are per 1,000,000 tokens, in the configured `currency`. The defaults
// below are approximate published list prices converted to EUR (~0.92 EUR/USD):
// an accurate budget only needs the prices to be in the right ballpark, and a
// workspace's effective budget (currency + monthly limit) is tunable in the UI.

/** Price per 1M input/output tokens for one model. */
export interface ModelPrice {
  /** Price per 1M FRESH (uncached) input tokens. */
  inputPerMillion: number
  outputPerMillion: number
  /**
   * Price per 1M input tokens served from the provider's prompt cache. Omitted ⇒ derived
   * from {@link ModelPrice.inputPerMillion} via {@link CACHE_READ_MULTIPLIER}. An entry sets
   * this only where a vendor departs from the near-universal ratio, so the ~50 entries below
   * do not each restate the same arithmetic.
   */
  cacheReadPerMillion?: number
  /**
   * Price per 1M input tokens WRITTEN into the provider's cache. Omitted ⇒ derived via
   * {@link CACHE_WRITE_MULTIPLIER}. Dearer than fresh input, which is why it cannot be
   * folded into {@link ModelPrice.cacheReadPerMillion}: a loop that keeps invalidating its
   * prefix and a loop riding a warm cache differ by roughly 12x per cached token.
   */
  cacheWritePerMillion?: number
}

/**
 * Fallback ratio of a cache READ to fresh input, applied when a {@link ModelPrice} names no
 * `cacheReadPerMillion`. Anthropic, OpenAI, DeepSeek and Google all bill a prefix-cache hit at
 * 0.1x their base input rate, so a per-entry copy of the number would be ~50 chances to get one
 * of them wrong rather than a source of accuracy.
 */
export const CACHE_READ_MULTIPLIER = 0.1

/**
 * Fallback ratio of a cache WRITE to fresh input. Anthropic (the only vendor that bills a
 * separate write class at all) charges 1.25x for the 5-minute TTL and 2x for the 1-hour one;
 * the harnesses request the default 5-minute TTL, so 1.25 is the rate our calls actually
 * incur rather than the worst case. A model whose write class is dearer names its own
 * `cacheWritePerMillion`.
 */
export const CACHE_WRITE_MULTIPLIER = 1.25

/**
 * A {@link ModelPrice} with both cache tiers resolved — no optional fields left to derive.
 *
 * Declared as kernel's {@link LlmTokenRates} rather than a second copy of the same four fields,
 * because {@link ratesFor} IS what a facade hands the telemetry rollup as its rate resolver. A
 * structural twin would let the two shapes drift apart while every call site still compiled.
 */
export type ResolvedModelPrice = LlmTokenRates

/**
 * The three ORTHOGONAL input classes a call spent, as the telemetry side carries them
 * (`LlmCallMetric`): fresh input, cache reads and cache writes are additive, never nested, so
 * total input is their sum. Priced apart because their rates differ by more than an order of
 * magnitude — summing them first and applying the fresh rate is what made a 31M-token,
 * 99.998%-cache-read run meter at roughly ten times what it cost.
 */
export interface InputTokenClassUsage {
  /** FRESH (uncached) input tokens, exclusive of both cache classes. */
  promptTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface SpendPricing {
  /** ISO 4217 currency all prices and budgets are expressed in. */
  currency: string
  /** Budget for one billing period (a calendar month). */
  monthlyLimit: number
  /** Per-model prices, keyed by `provider:model` then by bare `provider`. */
  prices: Record<string, ModelPrice>
  /** Fallback price for any model without a specific or provider-level entry. */
  defaultPrice: ModelPrice
  /**
   * Operator hard ceiling on the ACCOUNT-tier monthly budget, from the deployment env
   * var `BUDGET_MAX_MONTHLY_PER_ACCOUNT`. Undefined ⇒ no operator ceiling. When set it
   * caps whatever value the UI submits AND acts as the effective account budget when no
   * account limit is configured. See the tiered-budgets initiative.
   */
  accountMonthlyLimitCap?: number
  /**
   * Operator hard ceiling on the USER-tier monthly budget, from the deployment env var
   * `BUDGET_MAX_MONTHLY_PER_USER`. Undefined ⇒ no operator ceiling. Same double duty as
   * {@link accountMonthlyLimitCap}.
   */
  userMonthlyLimitCap?: number
}

/**
 * The effective monthly limit for a budget tier: the smaller of the tier's configured
 * limit and the operator env cap, treating an absent value as "no constraint". Returns
 * `Infinity` when neither is set — the tier is inactive and never gates. `0` is a real
 * limit ("no paid spend"), not "absent", so it is respected.
 */
export function effectiveTierLimit(
  configured: number | null | undefined,
  cap: number | null | undefined,
): number {
  const values: number[] = []
  if (configured != null) values.push(configured)
  if (cap != null) values.push(cap)
  return values.length > 0 ? Math.min(...values) : Number.POSITIVE_INFINITY
}

/**
 * Built-in approximate EUR prices per 1M tokens. Keys are matched most-specific
 * first: exact `provider:model`, then the bare `provider`, then `defaultPrice`.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic (list prices from the Claude model catalog, USD→EUR ~0.92).
  // Claude Fable 5 is above Opus-tier ($10 in / $50 out per 1M).
  'anthropic:claude-fable-5': { inputPerMillion: 9.2, outputPerMillion: 46 },
  // Claude Opus 5 lands at Opus-tier list price ($5 in / $25 out per 1M) — same as the
  // Opus 4.8 it supersedes in the catalog. Opus 4.8 keeps its entry: a workspace can
  // still pin it through the dynamic OpenRouter catalog, and historical spend rows
  // recorded against it must keep costing correctly.
  'anthropic:claude-opus-5': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'anthropic:claude-opus-4-8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'anthropic:claude-sonnet-5': { inputPerMillion: 1.84, outputPerMillion: 9.2 },
  'anthropic:claude-sonnet-4-6': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  'anthropic:claude-haiku-4-5': { inputPerMillion: 0.92, outputPerMillion: 4.6 },
  anthropic: { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  // OpenAI (approximate list prices, USD→EUR ~0.92).
  'openai:gpt-4o': { inputPerMillion: 2.3, outputPerMillion: 9.2 },
  'openai:gpt-4o-mini': { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // ChatGPT/Codex subscription models (informational list prices, USD→EUR ~0.92). Keys are
  // the Codex `--model` slugs the catalog dispatches, so the GPT-5.6 tiers and plain GPT-5.5
  // — never a `-codex`-suffixed id, which no longer exists past GPT-5.3.
  'openai:gpt-5.6-sol': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openai:gpt-5.6-terra': { inputPerMillion: 0.92, outputPerMillion: 5.52 },
  'openai:gpt-5.6-luna': { inputPerMillion: 0.09, outputPerMillion: 0.55 },
  'openai:gpt-5.5': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  openai: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // Cloudflare Workers AI is billed per "neuron"; treat it as roughly free. Every model
  // BELOW is a per-token-billed exception — see the note on the Kimi entries: a model with
  // real per-token pricing and no entry here meters at ~0.00 and escapes the budget gate.
  'workers-ai': { inputPerMillion: 0.1, outputPerMillion: 0.1 },
  // DeepSeek V4 Pro runs on Workers AI but is a partner model billed at provider
  // rates (served via Fireworks), not the near-free neuron rate above, so it needs
  // its own entry. Approximate (USD→EUR ~0.92).
  'workers-ai:deepseek/deepseek-v4-pro': { inputPerMillion: 0.5, outputPerMillion: 2 },
  // Kimi K2.5 / K2.6 / K2.7 likewise run on Workers AI as partner models billed at Workers
  // AI's published per-token rate, NOT the near-free `workers-ai` neuron rate — without
  // these explicit entries a Cloudflare-Kimi run (the default coder) would fall back to
  // 0.1/0.1 and meter as ~0.00. Cloudflare lists K2.6/K2.7 at $0.95 in / $4.00 out and the
  // older K2.5 at $0.60 in / $3.00 out per 1M (USD→EUR ~0.92); these are Cloudflare's
  // marked-up rates, above Moonshot's direct list (`moonshot:kimi-k2.6`). Cloudflare
  // publishes no separate cached-input rate for these, so they take the derived tiers. See
  // workers-ai/platform/pricing.
  'workers-ai:@cf/moonshotai/kimi-k2.5': { inputPerMillion: 0.55, outputPerMillion: 2.76 },
  'workers-ai:@cf/moonshotai/kimi-k2.6': { inputPerMillion: 0.87, outputPerMillion: 3.68 },
  'workers-ai:@cf/moonshotai/kimi-k2.7-code': { inputPerMillion: 0.87, outputPerMillion: 3.68 },
  // The remaining per-token-billed Workers AI models the catalog exposes. GLM-5.2 is the
  // default architect/reviewer routing and the R1 distill is the DeepSeek Cloudflare
  // fallback, so both were metering at the near-free neuron rate above.
  'workers-ai:@cf/zai-org/glm-5.2': { inputPerMillion: 1.29, outputPerMillion: 4.05 },
  'workers-ai:@cf/zai-org/glm-4.7-flash': { inputPerMillion: 0.06, outputPerMillion: 0.37 },
  'workers-ai:@cf/openai/gpt-oss-120b': { inputPerMillion: 0.32, outputPerMillion: 0.69 },
  'workers-ai:@cf/meta/llama-4-scout-17b-16e-instruct': {
    inputPerMillion: 0.25,
    outputPerMillion: 0.78,
  },
  'workers-ai:@cf/qwen/qwen3-30b-a3b-fp8': { inputPerMillion: 0.05, outputPerMillion: 0.31 },
  'workers-ai:@cf/deepseek-ai/deepseek-r1-distill-qwen-32b': {
    inputPerMillion: 0.46,
    outputPerMillion: 4.49,
  },
  // DeepSeek API. The `deepseek-chat` / `deepseek-reasoner` aliases were retired in July
  // 2026 in favour of the V4 pair; the old key is kept so historical spend rows recorded
  // against it keep costing correctly. (USD→EUR ~0.92.)
  'deepseek:deepseek-v4-flash': { inputPerMillion: 0.13, outputPerMillion: 0.26 },
  'deepseek:deepseek-v4-pro': { inputPerMillion: 0.4, outputPerMillion: 0.8 },
  'deepseek:deepseek-chat': { inputPerMillion: 0.26, outputPerMillion: 1.01 },
  deepseek: { inputPerMillion: 0.4, outputPerMillion: 0.8 },
  // Alibaba DashScope (approximate qwen3.7-max list prices, USD→EUR ~0.92).
  'qwen:qwen3.7-max': { inputPerMillion: 2.3, outputPerMillion: 6.9 },
  'qwen:qwen3-max': { inputPerMillion: 1.1, outputPerMillion: 5.5 },
  qwen: { inputPerMillion: 2.3, outputPerMillion: 6.9 },
  // Moonshot AI direct (approximate list prices, USD→EUR ~0.92).
  'moonshot:kimi-k3': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  'moonshot:kimi-k2.6': { inputPerMillion: 0.55, outputPerMillion: 2.3 },
  moonshot: { inputPerMillion: 0.55, outputPerMillion: 2.3 },
  // OpenRouter — a passthrough gateway billed at the underlying provider's rates (no
  // per-token markup), so each curated model carries the upstream vendor's list price
  // (USD→EUR ~0.92). Keyed by the OpenRouter `vendor/model` slug. The bare `openrouter`
  // fallback is a mid-range guess for any uncatalogued slug.
  'openrouter:anthropic/claude-fable-5': { inputPerMillion: 9.2, outputPerMillion: 46 },
  'openrouter:anthropic/claude-opus-5': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'openrouter:anthropic/claude-opus-4.8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'openrouter:google/gemini-3.1-pro-preview': { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'openrouter:google/gemini-3.6-flash': { inputPerMillion: 1.38, outputPerMillion: 6.9 },
  'openrouter:openai/gpt-5.6-sol': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openrouter:openai/gpt-5.6-terra': { inputPerMillion: 0.92, outputPerMillion: 5.52 },
  'openrouter:openai/gpt-5.6-luna': { inputPerMillion: 0.09, outputPerMillion: 0.55 },
  'openrouter:openai/gpt-5.5': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openrouter:openai/gpt-oss-120b': { inputPerMillion: 0.03, outputPerMillion: 0.16 },
  'openrouter:deepseek/deepseek-v4-flash': { inputPerMillion: 0.13, outputPerMillion: 0.26 },
  'openrouter:deepseek/deepseek-v4-pro': { inputPerMillion: 0.4, outputPerMillion: 0.8 },
  'openrouter:moonshotai/kimi-k2.7-code': { inputPerMillion: 0.67, outputPerMillion: 3.22 },
  'openrouter:moonshotai/kimi-k3': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  'openrouter:z-ai/glm-5.2': { inputPerMillion: 1.09, outputPerMillion: 3.44 },
  'openrouter:z-ai/glm-4.7-flash': { inputPerMillion: 0.06, outputPerMillion: 0.37 },
  'openrouter:qwen/qwen3.7-max': { inputPerMillion: 1.36, outputPerMillion: 4.07 },
  openrouter: { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  // LiteLLM — an operator-hosted gateway whose true cost depends entirely on the backend
  // model it routes to, which we can't know here. Default to the generic fallback rate.
  litellm: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // AWS Bedrock: deliberately a BARE provider entry with no per-model keys, because a
  // Bedrock ref carries the operator's geo/global inference prefix (`eu.anthropic.…`), which
  // differs per Region, and `priceFor` matches `provider:model` EXACTLY: a per-model key
  // would silently never match and fall through anyway. The rate errs HIGH, at the frontier
  // tier this catalog can select on Bedrock (Opus 4.8 / GPT-5.5, ~$5 in / $30 out per 1M),
  // for the same reason the dynamic-OpenRouter overlay skips a zero price: a budget
  // safeguard must never undercount, and `defaultPrice` would meter an Opus-on-Bedrock run
  // at roughly a thirtieth of its real cost. Accurate per-model Bedrock pricing needs
  // prefix-aware matching in `priceFor`; see the initiative doc.
  bedrock: { inputPerMillion: 4.6, outputPerMillion: 27.6 },
}

/** Default budget: roughly 100 EUR of tokens per calendar month. */
export const DEFAULT_MONTHLY_LIMIT_EUR = 100

export const DEFAULT_SPEND_PRICING: SpendPricing = {
  currency: 'EUR',
  monthlyLimit: DEFAULT_MONTHLY_LIMIT_EUR,
  prices: DEFAULT_MODEL_PRICES,
  defaultPrice: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
}

/**
 * Overlay a workspace's dynamic OpenRouter catalog prices onto a base pricing table,
 * keyed by the `openrouter:<slug>` ref so {@link priceFor} resolves each enabled model
 * at its real upstream rate (the prices are already in the spend currency — see
 * `OpenRouterCatalogService`). Used by the per-workspace `/models` cost resolver and the
 * spend gate so budgets meter dynamic models accurately instead of the bare-`openrouter`
 * fallback guess. Returns a new {@link SpendPricing}; the input is not mutated.
 *
 * A model whose cached price is entirely non-positive (OpenRouter reported no pricing, so
 * `parseModels` zeroed it) is SKIPPED rather than overlaid as free: a budget safeguard must
 * never undercount, so such a model keeps the more conservative bare-`openrouter` (or curated)
 * fallback instead of being metered at zero.
 */
export function withDynamicPrices(
  pricing: SpendPricing,
  models: OpenRouterModelMeta[],
): SpendPricing {
  if (models.length === 0) return pricing
  const prices: Record<string, ModelPrice> = { ...pricing.prices }
  for (const m of models) {
    if (m.inputPerMillion <= 0 && m.outputPerMillion <= 0) continue
    prices[`openrouter:${m.id}`] = {
      inputPerMillion: m.inputPerMillion,
      outputPerMillion: m.outputPerMillion,
    }
  }
  return { ...pricing, prices }
}

/**
 * Resolve a workspace's effective pricing from the base table + its per-workspace
 * budget overrides (currency / monthly limit). A null override falls back to the
 * base value, so an unconfigured workspace gets the built-in defaults unchanged.
 * Returns a new {@link SpendPricing}; the input is not mutated.
 */
export function mergeSpendPricing(
  base: SpendPricing,
  overrides: Pick<WorkspaceSettings, 'spendCurrency' | 'spendMonthlyLimit'> | null,
): SpendPricing {
  if (!overrides) return base
  return {
    ...base,
    currency: overrides.spendCurrency ?? base.currency,
    monthlyLimit: overrides.spendMonthlyLimit ?? base.monthlyLimit,
    prices: base.prices,
    defaultPrice: base.defaultPrice,
  }
}

/** Resolve the price for a model, most-specific entry first. */
export function priceFor(pricing: SpendPricing, ref: ModelRef): ModelPrice {
  return (
    pricing.prices[`${ref.provider}:${ref.model}`] ??
    pricing.prices[ref.provider] ??
    pricing.defaultPrice
  )
}

/**
 * {@link priceFor} with both cache tiers filled in from the multipliers where the entry names
 * none. Every per-class cost goes through this rather than reading {@link ModelPrice} directly,
 * so a caller can never silently price a cache class at the fresh rate by forgetting the `??`.
 */
export function ratesFor(pricing: SpendPricing, ref: ModelRef): ResolvedModelPrice {
  const price = priceFor(pricing, ref)
  return {
    inputPerMillion: price.inputPerMillion,
    outputPerMillion: price.outputPerMillion,
    cacheReadPerMillion: price.cacheReadPerMillion ?? price.inputPerMillion * CACHE_READ_MULTIPLIER,
    cacheWritePerMillion:
      price.cacheWritePerMillion ?? price.inputPerMillion * CACHE_WRITE_MULTIPLIER,
  }
}

/**
 * Cost of one call's usage priced PER INPUT CLASS, in the pricing currency — the accurate
 * form, used wherever the producer could report the split.
 *
 * {@link estimateCost} is the fallback for a producer that reports one lumped input count: it
 * prices the whole of it as fresh, which OVER-states a cached call and never under-states one.
 * That direction is deliberate — a budget safeguard that undercounts stops safeguarding.
 */
export function estimateClassedCost(
  pricing: SpendPricing,
  ref: ModelRef,
  usage: InputTokenClassUsage & { outputTokens: number },
): number {
  // The arithmetic itself is kernel's, shared with the telemetry rollup and the export, so the
  // ledger and the run surfaces cannot come to price the same classes differently.
  return costOfTokenClasses(ratesFor(pricing, ref), {
    promptTokens: usage.promptTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    completionTokens: usage.outputTokens,
  })
}

/**
 * A {@link ModelCostResolver}-shaped closure over a {@link SpendPricing}, for the
 * model catalog to surface each model's informational list cost in the picker.
 */
export function modelCostResolver(
  pricing: SpendPricing,
): (ref: ModelRef) => { inputPerMillion: number; outputPerMillion: number; currency: string } {
  return (ref) => {
    const price = priceFor(pricing, ref)
    return {
      inputPerMillion: price.inputPerMillion,
      outputPerMillion: price.outputPerMillion,
      currency: pricing.currency,
    }
  }
}

/**
 * Cost of a single call's token usage, in the pricing currency, from a LUMPED input count.
 *
 * Prices the whole input at the fresh rate because that is all this shape says: an
 * {@link AgentTokenUsage} whose producer could not report the class split. Where the split IS
 * available, {@link estimateClassedCost} is the accurate function and this one over-states.
 */
export function estimateCost(pricing: SpendPricing, ref: ModelRef, usage: AgentTokenUsage): number {
  const price = priceFor(pricing, ref)
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion
  )
}

/**
 * Build the env-driven operator budget-cap overlay for a {@link SpendPricing}. Each cap
 * is applied only when it is a non-negative number; a missing/invalid value leaves that
 * tier uncapped. Shared by the Node and Cloudflare config loaders so both runtimes read
 * `BUDGET_MAX_MONTHLY_PER_ACCOUNT` / `BUDGET_MAX_MONTHLY_PER_USER` identically.
 */
export function budgetCapsOverlay(
  accountCap: number | undefined,
  userCap: number | undefined,
): Partial<Pick<SpendPricing, 'accountMonthlyLimitCap' | 'userMonthlyLimitCap'>> {
  const overlay: Partial<Pick<SpendPricing, 'accountMonthlyLimitCap' | 'userMonthlyLimitCap'>> = {}
  if (accountCap != null && Number.isFinite(accountCap) && accountCap >= 0) {
    overlay.accountMonthlyLimitCap = accountCap
  }
  if (userCap != null && Number.isFinite(userCap) && userCap >= 0) {
    overlay.userMonthlyLimitCap = userCap
  }
  return overlay
}

/** Start of the calendar month containing `epochMs`, in UTC (epoch ms). */
export function startOfMonthUtc(epochMs: number): number {
  const d = new Date(epochMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}

/**
 * Start of the month AFTER the one containing `epochMs`, in UTC: the exclusive end of a
 * billing period, which is what the spend forecast extrapolates to. `Date.UTC` normalises a
 * month index of 12 into the next January, so no year wrap is needed here.
 */
export function startOfNextMonthUtc(epochMs: number): number {
  const d = new Date(epochMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}
