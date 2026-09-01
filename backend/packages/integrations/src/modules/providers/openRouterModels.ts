import type { OpenRouterModelMeta } from '@cat-factory/contracts'

// Reading OpenRouter's `/models` payload into the metadata a workspace stores.
//
// Its own module rather than a helper inside `OpenRouterCatalogService`, because the PRICE fold
// is the intricate part and the service is about leasing a key and persisting a subset. What
// makes it intricate is that OpenRouter does not publish one rate per model: a model carries a
// base rate, an optional account-wide `discount`, up to three cache classes, and a list of
// conditional `overrides` that re-price it by prompt length and time of day. Reading only
// `prompt`/`completion` (which is what this repo did until now) meters a long-context call at
// the cheap band and every cache hit at a derived guess.
//
// Everything here is USD per TOKEN as OpenRouter states it (as STRINGS, deliberately, to avoid
// float precision loss; `"0"` means free), converted once to spend-currency per MILLION tokens.
// Getting that unit wrong is a 1,000,000x error in a budget safeguard, which is why the
// conversion happens in exactly one function.

/** One conditional pricing band, as `/models` states it. */
interface RawPricingOverride {
  prompt?: unknown
  completion?: unknown
  input_cache_read?: unknown
  input_cache_write?: unknown
  input_cache_write_1h?: unknown
}

/** The `pricing` object of one `/models` entry, in the fields this platform reads. */
interface RawPricing {
  prompt?: unknown
  completion?: unknown
  /** Fraction (0..1) taken off every listed rate for this account. */
  discount?: unknown
  input_cache_read?: unknown
  input_cache_write?: unknown
  input_cache_write_1h?: unknown
  overrides?: unknown
}

/** One `/models` entry, in the fields this platform reads. */
interface RawModel {
  id?: unknown
  name?: unknown
  canonical_slug?: unknown
  context_length?: unknown
  expiration_date?: unknown
  pricing?: RawPricing
}

/** The per-rate keys shared by a base price and a conditional override. */
type RateKey = 'prompt' | 'completion' | 'input_cache_read' | 'input_cache_write'

/**
 * USD-per-token (a string or number) → spend-currency per 1M tokens, rounded to 4 dp.
 *
 * `undefined` for anything that is not a usable rate, which is a DIFFERENT fact from zero: a
 * missing cache rate means "derive the fallback multiplier", while a published `"0"` means the
 * gateway serves that class free. Only a negative or non-numeric value is rejected outright.
 */
function perMillion(usdPerToken: unknown, rate: number): number | undefined {
  if (usdPerToken === undefined || usdPerToken === null || usdPerToken === '') return undefined
  const n = typeof usdPerToken === 'number' ? usdPerToken : Number(usdPerToken)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 1_000_000 * rate * 10_000) / 10_000
}

/**
 * The DEAREST rate for one class across the base price and every conditional override.
 *
 * A max-fold rather than a pick, because which band applies depends on the prompt's length and
 * on the wall clock at call time, neither of which is known when a catalog is refreshed. A
 * budget safeguard is allowed to be wrong in one direction only, so it budgets against the most
 * expensive band a call could land in. Undefined only when NO band states the class at all.
 */
function dearestRate(
  pricing: RawPricing,
  overrides: readonly RawPricingOverride[],
  key: RateKey,
  rate: number,
): number | undefined {
  const candidates = [pricing[key], ...overrides.map((o) => o[key])]
    .map((value) => perMillion(value, rate))
    .filter((value): value is number => value !== undefined)
  return candidates.length === 0 ? undefined : Math.max(...candidates)
}

/**
 * The cache-WRITE rate, preferring the 5-minute TTL over the 1-hour one.
 *
 * Deliberately NOT the max-fold the conditional bands get, and the difference is what is
 * KNOWN. Which override band applies is unknowable at refresh time; which cache TTL this
 * platform requests is not, because the harnesses ask for the default 5-minute one. That is the
 * same reasoning behind `CACHE_WRITE_MULTIPLIER`'s 1.25 in the spend table, so budgeting the
 * 1-hour rate here would make the dynamic path contradict the static one for no gain.
 * `input_cache_write_1h` is the fallback for a model that publishes only the long TTL.
 */
function cacheWriteRate(
  pricing: RawPricing,
  overrides: readonly RawPricingOverride[],
  rate: number,
): number | undefined {
  return (
    dearestRate(pricing, overrides, 'input_cache_write', rate) ??
    perMillion(pricing.input_cache_write_1h, rate)
  )
}

/**
 * The multiplier an account-wide `discount` applies to every listed rate.
 *
 * Ignored unless it is a fraction in [0, 1]: a garbled value must not silently multiply a
 * budget, and 1 (no discount) is the safe reading of one.
 */
function discountFactor(discount: unknown): number {
  return typeof discount === 'number' && Number.isFinite(discount) && discount >= 0 && discount <= 1
    ? 1 - discount
    : 1
}

/** A trimmed non-empty string, or undefined. Keeps `''` out of the persisted metadata. */
function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Map OpenRouter's `/models` payload to the metadata a workspace persists.
 *
 * `inputPerMillion` / `outputPerMillion` stay REQUIRED and fall back to 0 for a model OpenRouter
 * priced not at all, because that is the existing signal `withDynamicPrices` reads to SKIP the
 * overlay and keep the more conservative bare-`openrouter` rate. The cache classes are optional
 * for the opposite reason: absent there means "derive the multiplier", and a 0 would mean "this
 * gateway serves cache hits free".
 */
export function parseOpenRouterModels(data: unknown, rate: number): OpenRouterModelMeta[] {
  if (!Array.isArray(data)) return []
  const out: OpenRouterModelMeta[] = []
  for (const raw of data as RawModel[]) {
    const id = text(raw?.id)
    if (!id) continue
    const pricing = raw?.pricing ?? {}
    const overrides = Array.isArray(pricing.overrides)
      ? (pricing.overrides as RawPricingOverride[])
      : []
    const factor = discountFactor(pricing.discount)
    const discounted = (value: number | undefined): number | undefined =>
      value === undefined ? undefined : Math.round(value * factor * 10_000) / 10_000

    const input = discounted(dearestRate(pricing, overrides, 'prompt', rate))
    const output = discounted(dearestRate(pricing, overrides, 'completion', rate))
    const cachedInput = discounted(dearestRate(pricing, overrides, 'input_cache_read', rate))
    const cacheWrite = discounted(cacheWriteRate(pricing, overrides, rate))
    const contextLength = typeof raw?.context_length === 'number' ? raw.context_length : undefined
    const canonicalSlug = text(raw?.canonical_slug)
    const expirationDate = text(raw?.expiration_date)

    out.push({
      id,
      name: text(raw?.name) ?? id,
      ...(contextLength ? { contextLength } : {}),
      inputPerMillion: input ?? 0,
      outputPerMillion: output ?? 0,
      ...(cachedInput === undefined ? {} : { cachedInputPerMillion: cachedInput }),
      ...(cacheWrite === undefined ? {} : { cacheWritePerMillion: cacheWrite }),
      ...(expirationDate ? { expirationDate } : {}),
      // Only when it says something `id` does not: a slug equal to the id is a field the SPA
      // would render twice and a byte every persisted row would carry for nothing.
      ...(canonicalSlug && canonicalSlug !== id ? { canonicalSlug } : {}),
    })
  }
  return out
}
