import type { InputTokenClassCounts, LlmTokenRates, ModelRef } from '@cat-factory/kernel'
import type { AgentTokenUsage } from '@cat-factory/kernel'
import { costOfTokenClasses } from '@cat-factory/kernel'
import type { OpenRouterModelMeta, WorkspaceSettings } from '@cat-factory/contracts'

// Pricing for the spend safeguard. Token usage is converted to a monetary cost
// so a single, human-meaningful budget ("~100 EUR/month") can gate execution
// regardless of which provider/model a given agent routes to.
//
// Prices are per 1,000,000 tokens, in the configured `currency`. The defaults
// below are published list prices converted to EUR at a FIXED 0.92 EUR/USD: an
// accurate budget only needs the prices to be in the right ballpark, and a
// workspace's effective budget (currency + monthly limit) is tunable in the UI.
//
// That factor is deliberately NOT today's spot rate (~0.86 EUR/USD as of the
// 2026-08 sweep, EUR/USD ~1.165) and is not re-based each time the euro moves.
// It is the table's standing conservative margin: holding it while the dollar is
// weaker over-states every entry by roughly 7%, which is the direction a budget
// safeguard is allowed to be wrong in. Re-base it only DOWNWARD-safely, i.e. never
// below the spot rate, and re-check the vendor list prices in the same pass.

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
 *
 * Kernel's type rather than a second copy of the same three fields, because it is what an
 * {@link AgentTokenUsage} producer fills in: a structural twin here would let the meter's shape
 * drift from the shape every producer reports, with every call site still compiling.
 */
export type InputTokenClassUsage = InputTokenClassCounts

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
  // `Math.min()` of nothing IS `Infinity`, which is exactly the inactive-tier answer, so the
  // empty case needs no branch of its own.
  return Math.min(...values)
}

/**
 * Built-in approximate EUR prices per 1M tokens. Keys are matched most-specific
 * first: exact `provider:model`, then the bare `provider`, then `defaultPrice`.
 */
export const DEFAULT_MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic (list prices from the Claude model catalog, USD→EUR ~0.92).
  // Claude Fable 5.1 and Claude Fable 5 both sit above Opus-tier, at the same $10 in / $50 out
  // per 1M: 5.1 succeeded 5 in the same tier at the same per-token price. What 5.1 changed is
  // the cache-READ rate, cut to $0.25/M from Fable 5's $1.00/M, and that is deliberately NOT
  // named here: the derived 0.1x floor lands on $1.00, which OVER-states a 5.1 cache read
  // fourfold, and a budget safeguard is allowed to be early but never short. Naming it would
  // be right the moment a route this platform sends breakpoints on serves the model.
  'anthropic:claude-fable-5-1': { inputPerMillion: 9.2, outputPerMillion: 46 },
  'anthropic:claude-fable-5': { inputPerMillion: 9.2, outputPerMillion: 46 },
  // Claude Opus 5 lands at Opus-tier list price ($5 in / $25 out per 1M) — same as the
  // Opus 4.8 it supersedes in the catalog. Opus 4.8 keeps its entry: a workspace can
  // still pin it through the dynamic OpenRouter catalog, and historical spend rows
  // recorded against it must keep costing correctly.
  'anthropic:claude-opus-5': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'anthropic:claude-opus-4-8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  // Sonnet 5 is $2 in / $10 out per 1M. That was the introductory rate through 2026-08-31,
  // and this entry deliberately held the $3 / $15 standard price it was scheduled to revert
  // to; on 2026-08-10 Anthropic cancelled that increase and made $2 / $10 the standard
  // price, so the promotion rule no longer applies and the entry drops to what is now list.
  // (The Gemini 3.7 Flash discount below is still live, so that entry still holds.) The
  // derived cache tiers land on Anthropic's own published rates at this base.
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
  // Post-2026-07-30 list: Sol $5 / $30, Terra $2 / $12, Luna $0.20 / $1.20 per 1M. Terra and
  // Luna were both carrying HALF their real rate here, which meters a Terra run at a twelfth
  // of an equivalent Sol one when the true gap is 2.5x on output. Cache reads bill at 0.1x
  // and writes at 1.25x on all three tiers, so both derived tiers are already exact.
  'openai:gpt-5.6-sol': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openai:gpt-5.6-terra': { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'openai:gpt-5.6-luna': { inputPerMillion: 0.18, outputPerMillion: 1.1 },
  'openai:gpt-5.5': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  openai: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // Cloudflare Workers AI is billed per "neuron"; treat it as roughly free. Every model
  // BELOW is a per-token-billed exception — see the note on the Kimi entries: a model with
  // real per-token pricing and no entry here meters at ~0.00 and escapes the budget gate.
  'workers-ai': { inputPerMillion: 0.1, outputPerMillion: 0.1 },
  // DeepSeek V4 Pro runs on Workers AI but is a partner model billed at provider
  // rates (served via Fireworks), not the near-free neuron rate above, so it needs
  // its own entry. Cloudflare lists the build it serves (`deepseek-v4-pro-0813`) at
  // $1.32 in / $3.96 out per 1M, which is DeepSeek's own PEAK first-party rate rather
  // than the ~$0.50 / $2.00 this entry used to guess: a Cloudflare V4 Pro run was
  // metering at under a third of its cost. Cloudflare's cached-input rate ($0.044/M)
  // is far BELOW the 0.1x floor the derived tier lands on, so the derived tier is
  // left in place: it over-states a cache read, which is the safe direction.
  'workers-ai:deepseek/deepseek-v4-pro': { inputPerMillion: 1.21, outputPerMillion: 3.64 },
  // Kimi K2.5 / K2.6 / K2.7 likewise run on Workers AI as partner models billed at Workers
  // AI's published per-token rate, NOT the near-free `workers-ai` neuron rate — without
  // these explicit entries a Cloudflare-Kimi run (the default coder) would fall back to
  // 0.1/0.1 and meter as ~0.00. Cloudflare lists K2.6/K2.7 at $0.95 in / $4.00 out and the
  // older K2.5 at $0.60 in / $3.00 out per 1M (USD→EUR ~0.92). These are NOT a Cloudflare
  // markup, as this note used to claim: Moonshot's own list moved to the same $0.95 / $4.00
  // for K2.6, so `moonshot:kimi-k2.6` below now carries the identical rate. See
  // workers-ai/platform/pricing.
  //
  // Cloudflare publishes a cached-input rate for all three ($0.10 for K2.5, $0.16 for K2.6,
  // $0.19 for K2.7), and each sits above the 0.1x floor these entries would otherwise derive.
  // All three are named for that reason: deriving the cheaper number under-meters every cache
  // read on the default coder route, which is the one direction the budget gate may not err in.
  'workers-ai:@cf/moonshotai/kimi-k2.5': {
    inputPerMillion: 0.55,
    outputPerMillion: 2.76,
    cacheReadPerMillion: 0.09,
  },
  'workers-ai:@cf/moonshotai/kimi-k2.6': {
    inputPerMillion: 0.87,
    outputPerMillion: 3.68,
    cacheReadPerMillion: 0.15,
  },
  'workers-ai:@cf/moonshotai/kimi-k2.7-code': {
    inputPerMillion: 0.87,
    outputPerMillion: 3.68,
    cacheReadPerMillion: 0.17,
  },
  // The remaining per-token-billed Workers AI models the catalog exposes. GLM-5.2 is the
  // default architect/reviewer routing and the R1 distill is the DeepSeek Cloudflare
  // fallback, so both were metering at the near-free neuron rate above. GLM-5.2's published
  // cached-input rate ($0.26/M) is likewise ~1.9x the derived floor, so it is named too.
  'workers-ai:@cf/zai-org/glm-5.2': {
    inputPerMillion: 1.29,
    outputPerMillion: 4.05,
    cacheReadPerMillion: 0.24,
  },
  // GLM-5.3 Flash bills at $0.15 in / $0.03 cached / $0.50 out per 1M on Workers AI, the same
  // list rate Z.ai and OpenRouter carry for it. Its cached tier is named because $0.03/M sits at
  // twice the 0.1x floor its cheap input implies, so deriving it would under-meter a warm prefix.
  'workers-ai:@cf/zai-org/glm-5.3-flash': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.46,
    cacheReadPerMillion: 0.03,
  },
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
  //
  // PRICED AT THE PEAK RATE, not the flat rate DeepSeek charged until 2026-08-16. From that
  // date the V4 family bills peak/off-peak (peak 01:00-04:00 and 06:00-10:00 UTC, off-peak
  // exactly half), so one model has two prices and this table has one slot. Peak is the
  // right slot to fill for the same reason the `bedrock` entry errs high: the budget gate
  // must never UNDERCOUNT, and a run that straddles a peak window would otherwise meter at
  // up to half its real cost. Off-peak runs are over-metered by 2x as the accepted cost of
  // that: an approximate budget tolerates being early, not being wrong in the unsafe
  // direction. Peak list is $0.44 in / $1.32 out (Flash) and $1.32 in / $3.96 out (Pro).
  //
  // DeepSeek now DOES publish the post-increase cache-hit rates, so both are named rather
  // than derived: $0.014/M Flash and $0.044/M Pro at peak (half of each off-peak), against a
  // derived 0.1x floor of $0.044 / $0.132 that over-stated a cache read by ~3x. Peak again,
  // to stay consistent with the fresh rates beside them.
  'deepseek:deepseek-v4-flash': {
    inputPerMillion: 0.4,
    outputPerMillion: 1.21,
    cacheReadPerMillion: 0.013,
  },
  'deepseek:deepseek-v4-pro': {
    inputPerMillion: 1.21,
    outputPerMillion: 3.64,
    cacheReadPerMillion: 0.04,
  },
  'deepseek:deepseek-chat': { inputPerMillion: 0.26, outputPerMillion: 1.01 },
  deepseek: { inputPerMillion: 1.21, outputPerMillion: 3.64 },
  // Alibaba DashScope (approximate qwen3.7-max list prices, USD→EUR ~0.92).
  'qwen:qwen3.7-max': { inputPerMillion: 2.3, outputPerMillion: 6.9 },
  // Qwen3.8 Max is $2 in / $0.25 implicitly cached / $6 out per 1M across its whole 1M window.
  // Its cached tier is named because $0.25 sits above the 0.1x floor its input implies ($0.20),
  // so deriving it would under-meter a run riding a warm prefix.
  'qwen:qwen3.8-max': { inputPerMillion: 1.84, outputPerMillion: 5.52, cacheReadPerMillion: 0.23 },
  // The pinned 0902 snapshot bills exactly as the undated alias does; Alibaba shipped the
  // post-training improvement without a price change. It gets its own row rather than leaning
  // on the bare `qwen` fallback, which is the older 3.7-Max rate and would meter it high on
  // input and short on output at the same time.
  'qwen:qwen3.8-max-0902': {
    inputPerMillion: 1.84,
    outputPerMillion: 5.52,
    cacheReadPerMillion: 0.23,
  },
  // Qwen3-Max is the superseded flagship, kept so historical spend rows keep costing; Alibaba
  // has since cut it to $0.78 in / $3.90 out per 1M, from the $1.20 / $6.00 this held.
  'qwen:qwen3-max': { inputPerMillion: 0.72, outputPerMillion: 3.59 },
  qwen: { inputPerMillion: 2.3, outputPerMillion: 6.9 },
  // Moonshot AI direct (list prices from platform.kimi.ai, USD→EUR ~0.92). K3 is $3 in /
  // $0.30 cached / $15 out per 1M, so its derived cache tier is already exact.
  //
  // K2.6 is $0.95 in / $0.16 cached / $4.00 out, NOT the $0.60 / $2.50 this entry carried:
  // Moonshot re-priced K2.6 up to what Cloudflare serves it at, and the stale figure metered
  // a direct-Moonshot K2.6 run at roughly 60% of its cost. The cached rate is named for the
  // same reason as the Cloudflare pair above (it sits above the 0.1x floor). The bare
  // fallback tracks K2.6, which is the model an unlisted `moonshot:` ref is most likely to be.
  'moonshot:kimi-k3': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  'moonshot:kimi-k2.6': {
    inputPerMillion: 0.87,
    outputPerMillion: 3.68,
    cacheReadPerMillion: 0.15,
  },
  moonshot: { inputPerMillion: 0.87, outputPerMillion: 3.68, cacheReadPerMillion: 0.15 },
  // Z.ai direct, the provider the GLM coding-plan subscription refs carry (`zai:glm-5.2`,
  // `zai:glm-5.3`). Those refs previously matched NO key here and fell through to
  // `defaultPrice` (0.14/0.55), which meters a GLM subscription run at roughly a tenth of
  // the tokens' list value. A flat-rate plan makes the figure informational rather than
  // billed, but the spend rollup is what an operator reads to compare a plan against
  // pay-as-you-go, so it has to carry the list price rather than an unrelated default.
  // Z.ai lists GLM-5.2 at $1.40 in / $0.26 cached / $4.40 out per 1M (USD→EUR ~0.92).
  //
  // GLM-5.3 shipped 2026-08-14 and initially had no published price, so this entry inherited
  // GLM-5.2's on the grounds of same base model and same vendor. Z.ai has since listed it at
  // $1.40 in / $0.26 cached / $4.40 out per 1M, identical to GLM-5.2, so the inherited rate is
  // now the published one and the two rows agree by fact rather than by assumption.
  //
  // GLM-5.3 Flash is a different tier entirely, listed at $0.15 in / $0.03 cached / $0.50 out.
  // PRICED AT THAT LIST, not at the 50% launch promotion Z.ai runs until 2026-09-09: a temporary
  // discount that lapses would leave the budget gate metering at half the real cost, and the gate
  // may never undercount (the rule the Gemini Flash row states at length).
  'zai:glm-5.3-flash': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.46,
    cacheReadPerMillion: 0.03,
  },
  'zai:glm-5.3': { inputPerMillion: 1.29, outputPerMillion: 4.05, cacheReadPerMillion: 0.24 },
  'zai:glm-5.2': { inputPerMillion: 1.29, outputPerMillion: 4.05, cacheReadPerMillion: 0.24 },
  zai: { inputPerMillion: 1.29, outputPerMillion: 4.05, cacheReadPerMillion: 0.24 },
  // xAI direct. Grok 4.6 bills in two bands: $2 in / $0.50 cached / $6 out per 1M below a
  // 200K-token prompt, and DOUBLE that for the whole request once the prompt crosses 200K.
  // Priced at the LONG band, because the budget gate must not undercount and this table has
  // no way to express a threshold that depends on the prompt actually sent. A short-prompt
  // run is over-metered by 2x as the accepted cost of that. (USD→EUR ~0.92.)
  'xai:grok-4.6': { inputPerMillion: 3.68, outputPerMillion: 11.04, cacheReadPerMillion: 0.92 },
  xai: { inputPerMillion: 3.68, outputPerMillion: 11.04, cacheReadPerMillion: 0.92 },
  // OpenRouter — a passthrough gateway billed at the underlying provider's rates (no
  // per-token markup), so each curated model carries the upstream vendor's list price
  // (USD→EUR ~0.92). Keyed by the OpenRouter `vendor/model` slug. The bare `openrouter`
  // fallback is a mid-range guess for any uncatalogued slug.
  // The 5.1 slug is DOTTED (`claude-fable-5.1`) where the direct id is dashed; see the catalog
  // entry. A key spelled the other way would silently fall through to the bare `openrouter`
  // row, which meters this model at a fifth of its cost.
  'openrouter:anthropic/claude-fable-5.1': { inputPerMillion: 9.2, outputPerMillion: 46 },
  'openrouter:anthropic/claude-fable-5': { inputPerMillion: 9.2, outputPerMillion: 46 },
  'openrouter:anthropic/claude-opus-5': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'openrouter:anthropic/claude-opus-4.8': { inputPerMillion: 4.6, outputPerMillion: 23 },
  'openrouter:google/gemini-3.1-pro-preview': { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'openrouter:google/gemini-3.6-flash': { inputPerMillion: 0.69, outputPerMillion: 3.45 },
  // Priced at Google's $0.75 / $3.75 list, NOT the $0.375 / $1.875 the route is still
  // discounted to. The discount is temporary and the budget gate may not undercount when it
  // lapses; over-metering by 2x while it holds is the accepted cost. Google has also
  // published a 100% increase on BOTH Flash rows for 2027-01-01, which this table does not
  // pre-empt: a future price is not the current one, and the next sweep lands it.
  'openrouter:google/gemini-3.7-flash': { inputPerMillion: 0.69, outputPerMillion: 3.45 },
  // 3.8 Flash launched at 3.7 Flash's list, $0.75 / $3.75, and is NOT discounted, so this row
  // is the rate actually billed rather than the deliberate over-count above it.
  'openrouter:google/gemini-3.8-flash': { inputPerMillion: 0.69, outputPerMillion: 3.45 },
  // The same OpenAI list prices as the direct rows above, and the same two stale halves
  // corrected. OpenRouter's own model page currently advertises Sol at $2 / $10, below both
  // OpenAI's list and its own Terra row; that is an upstream listing artefact, so the entry
  // stays on the vendor list price this passthrough gateway bills at.
  'openrouter:openai/gpt-5.6-sol': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openrouter:openai/gpt-5.6-terra': { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  'openrouter:openai/gpt-5.6-luna': { inputPerMillion: 0.19, outputPerMillion: 1.11 },
  'openrouter:openai/gpt-5.5': { inputPerMillion: 4.6, outputPerMillion: 27.6 },
  'openrouter:openai/gpt-oss-120b': { inputPerMillion: 0.034, outputPerMillion: 0.16 },
  // Meta Muse Spark 1.3, both tiers: $1.25 / $4.25 standard, $0.10 / $0.20 contributor. The
  // two are the same model on the same route, so the gap between these rows IS the entire
  // difference the contributor tier buys, and metering both at the standard rate would hide
  // the one thing a workspace picks between them for.
  //
  // Neither names a cache-read rate. Meta publishes one ($0.15/M standard, $0.002/M
  // contributor), but OpenRouter's caching docs carry no Meta section at all, so
  // `providerCachePolicy` answers `none` for the prefix and this platform reports no cache
  // class on the route. A pinned rate would assert a hit that nothing here knows how to enter.
  'openrouter:meta/muse-spark-1.3': { inputPerMillion: 1.15, outputPerMillion: 3.91 },
  'openrouter:meta/muse-spark-1.3-contributor': {
    inputPerMillion: 0.092,
    outputPerMillion: 0.184,
  },
  // Both DeepSeek slugs are unpinned MOVING ALIASES, and the catalog routes to them
  // deliberately (each follows the newest GA build), so these two entries track the alias's
  // blended rate rather than either the cheapest provider behind it or DeepSeek's own
  // first-party list. That blend moves, which is why each is stamped with what the
  // OpenRouter models API actually reported when it was last read, and why re-reading it is
  // part of every pricing sweep rather than something to infer from the vendor's own page.
  //
  // Observed 2026-09-04 by `scripts/check-openrouter-pins.mjs`: Flash $0.0886 in / $0.0177
  // cached / $0.1772 out, Pro $1.60 in / $0.135 cached / $3.20 out per 1M. Pro is unmoved since
  // the 2026-09-01 read; Flash has drifted up ~9% and the row below it was the checker's one
  // UNDERSTATED pin, which is the direction that matters: a budget metering below the live rate
  // is the failure this table's conservatism exists to rule out, so it is re-pinned even though
  // the gap is small. (An earlier read had Pro at $0.556 / $1.112 on 2026-08-26, a third of what
  // it bills now. That swing in five days is the case for the checker rather than for a sweep
  // nobody schedules.)
  'openrouter:deepseek/deepseek-v4-flash': {
    inputPerMillion: 0.082,
    outputPerMillion: 0.164,
    cacheReadPerMillion: 0.017,
  },
  'openrouter:deepseek/deepseek-v4-pro': {
    inputPerMillion: 1.48,
    outputPerMillion: 2.95,
    cacheReadPerMillion: 0.125,
  },
  // K2.7 Code's cache-read rate ($0.19/M) is ~2.8x the 0.1x floor its input implies, so it is
  // named; K3's ($0.30/M) IS the floor, so it derives.
  'openrouter:moonshotai/kimi-k2.7-code': {
    inputPerMillion: 0.62,
    outputPerMillion: 3.13,
    cacheReadPerMillion: 0.17,
  },
  'openrouter:moonshotai/kimi-k3': { inputPerMillion: 2.76, outputPerMillion: 13.8 },
  // $1.19 in / $0.221 cached / $3.74 out per 1M, roughly double the $0.63 / $1.98 this row
  // held: OpenRouter's GLM-5.2 route has converged on Z.ai's own $1.40 / $4.40 list as the
  // cheap open-weight providers behind the slug dropped out of the blend. The cached rate is
  // rounded UP: at 0.2 it sat under the live 0.2033, which the pin checker now reports because
  // it compares this class too.
  'openrouter:z-ai/glm-5.2': {
    inputPerMillion: 1.09,
    outputPerMillion: 3.44,
    cacheReadPerMillion: 0.21,
  },
  // The same Z.ai list rates as the `zai:` row above: OpenRouter passes the upstream vendor's
  // price through, and the launch promotion the slug is served at today is the half-rate this
  // row deliberately does not carry.
  'openrouter:z-ai/glm-5.3-flash': {
    inputPerMillion: 0.14,
    outputPerMillion: 0.46,
    cacheReadPerMillion: 0.03,
  },
  // OpenRouter's published cache-read rate ($0.01/M) is ABOVE the 0.1x derived floor this
  // model's cheap input implies ($0.006/M), so it is named rather than derived.
  'openrouter:z-ai/glm-4.7-flash': {
    inputPerMillion: 0.06,
    outputPerMillion: 0.37,
    cacheReadPerMillion: 0.01,
  },
  'openrouter:x-ai/grok-4.6': { inputPerMillion: 1.84, outputPerMillion: 5.52 },
  'openrouter:qwen/qwen3.7-max': { inputPerMillion: 1.36, outputPerMillion: 4.07 },
  // OpenRouter passes Alibaba's own Qwen3.8 Max rates through, cached tier included.
  'openrouter:qwen/qwen3.8-max': {
    inputPerMillion: 1.84,
    outputPerMillion: 5.52,
    cacheReadPerMillion: 0.23,
  },
  openrouter: { inputPerMillion: 1.84, outputPerMillion: 11.04 },
  // Bifrost / LiteLLM: operator-hosted gateways whose cost is the backend model each routes to.
  //
  // Bifrost names models by their CANONICAL `provider/model` pair, so where the route IS knowable
  // the real upstream rate is too, and the catalog's shipped `bifrost-default` entry routes
  // `openai/gpt-4o`. Priced here at that model's own direct rate (`openai:gpt-4o`) rather than the
  // gateway fallback, which would have metered the one Bifrost model this platform ships selectable
  // at a sixteenth of its cost: a budget safeguard must never undercount (the rule the `bedrock`
  // entry below states at length). Add a row per route as the catalog gains one.
  'bifrost:openai/gpt-4o': { inputPerMillion: 2.3, outputPerMillion: 9.2 },
  // The bare fallbacks, for a route this table cannot resolve: a repointed Bifrost model, and
  // every LiteLLM alias (the operator's own `model_name` from their `config.yaml`, which carries no
  // vendor to look up). NAMED rather than left to fall through to `defaultPrice`: that value is the
  // guess for a provider the platform does not know, so a later change to it must not silently
  // re-price a gateway the platform ships support for. Both under-count a frontier route, which is
  // the residual an operator fronting one accepts by repointing the entry.
  bifrost: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  litellm: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  // AWS Bedrock: deliberately a BARE provider entry with no per-model keys, because a
  // Bedrock ref carries the operator's geo/global inference prefix (`eu.anthropic.…`), which
  // differs per Region, and `priceFor` matches `provider:model` EXACTLY: a per-model key
  // would silently never match and fall through anyway. The rate errs HIGH, at the frontier
  // tier this catalog can select on Bedrock, for the same reason the dynamic-OpenRouter
  // overlay skips a zero price: a budget safeguard must never undercount, and `defaultPrice`
  // would meter a frontier-on-Bedrock run at roughly a sixtieth of its real cost. Accurate
  // per-model Bedrock pricing needs prefix-aware matching in `priceFor`; see the initiative doc.
  //
  // That ceiling MOVED with Claude Fable 5.1, which Bedrock serves from launch day: the
  // frontier tier here is now ~$10 in / $50 out per 1M, not the ~$5 / $30 of Opus 4.8 and
  // GPT-5.5. Adding a Bedrock flavour is therefore two edits, and the one that is easy to
  // forget is this one: leaving the row at the old tier meters every Fable-5.1-on-Bedrock run
  // at half its cost, which is the undercount this entry exists to rule out.
  bedrock: { inputPerMillion: 9.2, outputPerMillion: 46 },
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
 * `parseOpenRouterModels` zeroed it) is SKIPPED rather than overlaid as free: a budget safeguard
 * must never undercount, so such a model keeps the more conservative bare-`openrouter` (or
 * curated) fallback instead of being metered at zero.
 *
 * The two CACHE classes are carried through ONLY when OpenRouter published a POSITIVE rate, so an
 * absent one still falls to {@link CACHE_READ_MULTIPLIER} / {@link CACHE_WRITE_MULTIPLIER}.
 * Copying a derived multiple into the overlay instead would freeze today's ratio into every
 * stored row and make a gateway's own repricing unreachable, which is the whole reason the
 * dynamic path exists.
 *
 * A published zero is dropped for the same reason the base pair is: it cannot be told apart from
 * a placeholder for a class the gateway does not bill separately, and it is also what the
 * catalog's 4-dp rounding makes of any real rate below 0.00005/1M. Overlaid, it would meter every
 * cache hit on that model at nothing, which is the one direction a budget safeguard may never be
 * wrong in. The multiplier over-states instead, which is the direction that keeps safeguarding.
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
      ...(m.cachedInputPerMillion !== undefined && m.cachedInputPerMillion > 0
        ? { cacheReadPerMillion: m.cachedInputPerMillion }
        : {}),
      ...(m.cacheWritePerMillion !== undefined && m.cacheWritePerMillion > 0
        ? { cacheWritePerMillion: m.cacheWritePerMillion }
        : {}),
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
 * Cost of a single call's token usage, in the pricing currency — the ONE entry point for
 * pricing an {@link AgentTokenUsage}, whether or not its producer knew the class split.
 *
 * A usage carrying {@link AgentTokenUsage.inputClasses} is priced per class. One without is
 * priced with its whole input at the FRESH rate, because that is all that shape says: the
 * producer reported a single lumped count. That over-states a cached call and never
 * under-states one, the only safe direction for a budget gate.
 *
 * It branches HERE rather than leaving each caller to pick between this and
 * {@link estimateClassedCost}, because picking wrong is invisible: the lump function accepts a
 * classed usage happily and silently prices a cache-read-dominated run at up to ten times what
 * it cost. Only a caller holding classes with no `AgentTokenUsage` around them reaches for the
 * classed function directly.
 */
export function estimateCost(pricing: SpendPricing, ref: ModelRef, usage: AgentTokenUsage): number {
  if (usage.inputClasses) {
    return estimateClassedCost(pricing, ref, {
      ...usage.inputClasses,
      outputTokens: usage.outputTokens,
    })
  }
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
 *
 * What the key's ABSENCE means is the whole contract of an overlay, since a caller spreads it over
 * the configured pricing: a present key holding `undefined` erases the deployment's own cap. So
 * the tests check `Object.keys`, which is the only assertion that can see the difference.
 *
 * The `!= null` looks redundant beside `Number.isFinite` (false for anything that is not a number)
 * and at runtime it is: mutating it away changes no behaviour, which is why the mutation report
 * lists it as a survivor nothing can kill. It stands for the TYPECHECKER, which does not treat
 * `Number.isFinite` as a narrowing guard, so the `>= 0` beside it needs the null check to compile.
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
