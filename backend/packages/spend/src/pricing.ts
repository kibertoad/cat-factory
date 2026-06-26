import type { ModelRef } from '@cat-factory/kernel'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import type { OpenRouterModelMeta, WorkspaceSettings } from '@cat-factory/contracts'

// Pricing for the spend safeguard. Token usage is converted to a monetary cost
// so a single, human-meaningful budget ("~100 EUR/month") can gate execution
// regardless of which provider/model a given agent routes to.
//
// Prices are per 1,000,000 tokens, in the configured `currency`. The defaults
// below are approximate published list prices converted to EUR (~0.92 EUR/USD)
// and are deliberately operator-overridable: an accurate budget only needs the
// prices to be in the right ballpark, and rates change. Override PER WORKSPACE in
// the UI (the `workspace_settings.spend_model_prices` overrides, overlaid here).

/** Price per 1M input/output tokens for one model. */
export interface ModelPrice {
  inputPerMillion: number
  outputPerMillion: number
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
}

/**
 * Built-in approximate EUR prices per 1M tokens. Keys are matched most-specific
 * first: exact `provider:model`, then the bare `provider`, then `defaultPrice`.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic (list prices from the Claude model catalog, USD→EUR ~0.92).
  'anthropic:claude-opus-4-8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'anthropic:claude-sonnet-4-6': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  'anthropic:claude-haiku-4-5': { inputPerMillion: 0.92, outputPerMillion: 4.6 },
  anthropic: { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  // OpenAI (approximate list prices, USD→EUR ~0.92).
  'openai:gpt-4o': { inputPerMillion: 2.3, outputPerMillion: 9.2 },
  'openai:gpt-4o-mini': { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // ChatGPT/Codex subscription models (informational list prices, USD→EUR ~0.92).
  'openai:gpt-5.5-codex': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openai:gpt-5.4-codex': { inputPerMillion: 2.3, outputPerMillion: 13.8 },
  openai: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // Cloudflare Workers AI is billed per "neuron"; treat it as roughly free.
  'workers-ai': { inputPerMillion: 0.1, outputPerMillion: 0.1 },
  // DeepSeek V4 Pro runs on Workers AI but is a partner model billed at provider
  // rates (served via Fireworks), not the near-free neuron rate above, so it needs
  // its own entry. Approximate (USD→EUR ~0.92); tune via the per-workspace price overrides.
  'workers-ai:deepseek/deepseek-v4-pro': { inputPerMillion: 0.5, outputPerMillion: 2 },
  // Kimi K2.5 / K2.6 / K2.7 likewise run on Workers AI as partner models billed at Workers
  // AI's published per-token rate, NOT the near-free `workers-ai` neuron rate — without
  // these explicit entries a Cloudflare-Kimi run (the default coder) would fall back to
  // 0.1/0.1 and meter as ~0.00. Cloudflare lists K2.6/K2.7 at $0.95 in / $4.00 out and the
  // older K2.5 at $0.60 in / $3.00 out per 1M (USD→EUR ~0.92); these are Cloudflare's
  // marked-up rates, above Moonshot's direct list (`moonshot:kimi-k2.6`). The spend table
  // has no cached-input tier, so we use the standard cache-miss input rate. See
  // workers-ai/platform/pricing. Tune via SPEND_MODEL_PRICES.
  'workers-ai:@cf/moonshotai/kimi-k2.5': { inputPerMillion: 0.55, outputPerMillion: 2.76 },
  'workers-ai:@cf/moonshotai/kimi-k2.6': { inputPerMillion: 0.87, outputPerMillion: 3.68 },
  'workers-ai:@cf/moonshotai/kimi-k2.7-code': { inputPerMillion: 0.87, outputPerMillion: 3.68 },
  // DeepSeek API (approximate list prices for deepseek-chat, USD→EUR ~0.92).
  'deepseek:deepseek-chat': { inputPerMillion: 0.26, outputPerMillion: 1.01 },
  deepseek: { inputPerMillion: 0.26, outputPerMillion: 1.01 },
  // Alibaba DashScope (approximate qwen3-max list prices, USD→EUR ~0.92).
  'qwen:qwen3-max': { inputPerMillion: 1.1, outputPerMillion: 5.5 },
  qwen: { inputPerMillion: 1.1, outputPerMillion: 5.5 },
  // Moonshot AI direct (approximate kimi-k2.6 list prices, USD→EUR ~0.92).
  'moonshot:kimi-k2.6': { inputPerMillion: 0.55, outputPerMillion: 2.3 },
  moonshot: { inputPerMillion: 0.55, outputPerMillion: 2.3 },
  // OpenRouter — a passthrough gateway billed at the underlying provider's rates (no
  // per-token markup), so each curated model carries the upstream vendor's list price
  // (USD→EUR ~0.92). Keyed by the OpenRouter `vendor/model` slug. The bare `openrouter`
  // fallback is a mid-range guess for any uncatalogued slug — tune via the per-workspace price overrides.
  'openrouter:anthropic/claude-opus-4.8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'openrouter:google/gemini-3-pro': { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'openrouter:openai/gpt-5.5': { inputPerMillion: 3.68, outputPerMillion: 22.08 },
  'openrouter:deepseek/deepseek-chat': { inputPerMillion: 0.26, outputPerMillion: 1.01 },
  'openrouter:moonshotai/kimi-k2.7-code': { inputPerMillion: 0.55, outputPerMillion: 2.3 },
  openrouter: { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  // LiteLLM — an operator-hosted gateway whose true cost depends entirely on the backend
  // model it routes to, which we can't know here. Default to the generic fallback rate;
  // operators should override per their routing via the per-workspace price overrides.
  litellm: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
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
 * budget overrides (currency / monthly limit / per-model price overrides). A null
 * override falls back to the base value, so an unconfigured workspace gets the
 * built-in defaults unchanged. Per-model overrides are overlaid onto the base table
 * (most-specific-first resolution in {@link priceFor} is preserved). Returns a new
 * {@link SpendPricing}; the input is not mutated.
 */
export function mergeSpendPricing(
  base: SpendPricing,
  overrides: Pick<
    WorkspaceSettings,
    'spendCurrency' | 'spendMonthlyLimit' | 'spendModelPrices'
  > | null,
): SpendPricing {
  if (!overrides) return base
  const prices = overrides.spendModelPrices
    ? { ...base.prices, ...overrides.spendModelPrices }
    : base.prices
  return {
    currency: overrides.spendCurrency ?? base.currency,
    monthlyLimit: overrides.spendMonthlyLimit ?? base.monthlyLimit,
    prices,
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

/** Cost of a single call's token usage, in the pricing currency. */
export function estimateCost(pricing: SpendPricing, ref: ModelRef, usage: AgentTokenUsage): number {
  const price = priceFor(pricing, ref)
  return (
    (usage.inputTokens / 1_000_000) * price.inputPerMillion +
    (usage.outputTokens / 1_000_000) * price.outputPerMillion
  )
}

/** Start of the calendar month containing `epochMs`, in UTC (epoch ms). */
export function startOfMonthUtc(epochMs: number): number {
  const d = new Date(epochMs)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)
}
