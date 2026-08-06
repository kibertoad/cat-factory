import { describe, expect, it } from 'vitest'
import {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_MULTIPLIER,
  DEFAULT_SPEND_PRICING,
  budgetCapsOverlay,
  effectiveTierLimit,
  estimateClassedCost,
  estimateCost,
  mergeSpendPricing,
  modelCostResolver,
  priceFor,
  ratesFor,
  startOfMonthUtc,
  startOfNextMonthUtc,
  withDynamicPrices,
  type SpendPricing,
} from './pricing.js'

// The pricing resolution layer: which entry a ref resolves to, what the derived cache tiers cost,
// what a cap does to a tier limit, and where a billing period starts and ends. Every number here
// is arithmetic a budget gate concludes from, so the assertions pin the VALUE rather than that a
// value came back.

/** A small table of our own, so a shipped-price edit never rewrites these expectations. */
const pricing: SpendPricing = {
  currency: 'EUR',
  monthlyLimit: 100,
  prices: {
    'acme:big': { inputPerMillion: 10, outputPerMillion: 40 },
    // A vendor that departs from the near-universal cache ratios states both tiers itself.
    'acme:cached': {
      inputPerMillion: 10,
      outputPerMillion: 40,
      cacheReadPerMillion: 3,
      cacheWritePerMillion: 20,
    },
    acme: { inputPerMillion: 5, outputPerMillion: 20 },
  },
  defaultPrice: { inputPerMillion: 1, outputPerMillion: 2 },
}

describe('effectiveTierLimit', () => {
  it('takes the SMALLER of the configured limit and the operator cap', () => {
    expect(effectiveTierLimit(300, 100)).toBe(100)
    expect(effectiveTierLimit(50, 100)).toBe(50)
  })

  it('treats an absent value as no constraint, on either side', () => {
    expect(effectiveTierLimit(300, null)).toBe(300)
    expect(effectiveTierLimit(null, 100)).toBe(100)
    expect(effectiveTierLimit(undefined, undefined)).toBe(Number.POSITIVE_INFINITY)
  })

  it('respects 0 as a real limit ("no paid spend"), not as absent', () => {
    expect(effectiveTierLimit(0, 100)).toBe(0)
    expect(effectiveTierLimit(null, 0)).toBe(0)
  })
})

describe('priceFor', () => {
  it('resolves the exact `provider:model` entry first', () => {
    expect(priceFor(pricing, { provider: 'acme', model: 'big' })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 40,
    })
  })

  it('falls back to the bare provider entry, then to the default price', () => {
    expect(priceFor(pricing, { provider: 'acme', model: 'unlisted' }).inputPerMillion).toBe(5)
    expect(priceFor(pricing, { provider: 'nobody', model: 'nothing' })).toEqual(
      pricing.defaultPrice,
    )
  })
})

describe('ratesFor', () => {
  it('derives both cache tiers from the fresh input rate where the entry names none', () => {
    const rates = ratesFor(pricing, { provider: 'acme', model: 'big' })
    expect(rates.cacheReadPerMillion).toBeCloseTo(10 * CACHE_READ_MULTIPLIER)
    expect(rates.cacheWritePerMillion).toBeCloseTo(10 * CACHE_WRITE_MULTIPLIER)
    // A write costs MORE than fresh input and a read costs far less: the whole reason the two
    // cannot be folded into one derived tier.
    expect(rates.cacheWritePerMillion).toBeGreaterThan(rates.inputPerMillion)
    expect(rates.cacheReadPerMillion).toBeLessThan(rates.inputPerMillion)
  })

  it('keeps an entry that states its own cache rates instead of deriving them', () => {
    expect(ratesFor(pricing, { provider: 'acme', model: 'cached' })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 40,
      cacheReadPerMillion: 3,
      cacheWritePerMillion: 20,
    })
  })
})

describe('estimateCost (lumped input)', () => {
  it('prices input and output at their own rates and SUMS them', () => {
    const cost = estimateCost(
      pricing,
      { provider: 'acme', model: 'big' },
      { inputTokens: 2_000_000, outputTokens: 500_000 },
    )
    // 2M at 10/M plus 0.5M at 40/M.
    expect(cost).toBeCloseTo(20 + 20)
  })

  it('prices the whole input as FRESH, which over-states a cached call rather than under-stating it', () => {
    const ref = { provider: 'acme', model: 'big' }
    const lumped = estimateCost(pricing, ref, { inputTokens: 1_000_000, outputTokens: 0 })
    const classed = estimateClassedCost(pricing, ref, {
      promptTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 0,
      outputTokens: 0,
    })
    expect(lumped).toBeGreaterThan(classed)
  })
})

describe('estimateClassedCost', () => {
  it('prices each input class at its own rate', () => {
    const cost = estimateClassedCost(
      pricing,
      { provider: 'acme', model: 'cached' },
      {
        promptTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 1_000_000,
        outputTokens: 500_000,
      },
    )
    // 10 fresh + 2x3 read + 20 write + 0.5x40 output.
    expect(cost).toBeCloseTo(10 + 6 + 20 + 20)
  })
})

describe('modelCostResolver', () => {
  it('surfaces the resolved list rates in the pricing currency', () => {
    expect(modelCostResolver(pricing)({ provider: 'acme', model: 'big' })).toEqual({
      inputPerMillion: 10,
      outputPerMillion: 40,
      currency: 'EUR',
    })
  })
})

describe('mergeSpendPricing', () => {
  it('returns the base table unchanged when there are no overrides', () => {
    expect(mergeSpendPricing(pricing, null)).toBe(pricing)
  })

  it('overlays the workspace currency and limit', () => {
    const merged = mergeSpendPricing(pricing, { spendCurrency: 'USD', spendMonthlyLimit: 250 })
    expect(merged.currency).toBe('USD')
    expect(merged.monthlyLimit).toBe(250)
    // The price table itself is never overridden, and the input is not mutated.
    expect(merged.prices).toBe(pricing.prices)
    expect(pricing.currency).toBe('EUR')
  })

  it('falls back to the base value per field for an unset override', () => {
    const merged = mergeSpendPricing(pricing, { spendCurrency: null, spendMonthlyLimit: null })
    expect(merged.currency).toBe('EUR')
    expect(merged.monthlyLimit).toBe(100)
  })
})

describe('withDynamicPrices', () => {
  const meta = (id: string, inputPerMillion: number, outputPerMillion: number) =>
    ({ id, inputPerMillion, outputPerMillion }) as Parameters<typeof withDynamicPrices>[1][number]

  it('overlays each catalog model onto its `openrouter:<slug>` ref', () => {
    const overlaid = withDynamicPrices(pricing, [meta('vendor/model', 7, 21)])
    expect(priceFor(overlaid, { provider: 'openrouter', model: 'vendor/model' })).toEqual({
      inputPerMillion: 7,
      outputPerMillion: 21,
    })
    // The base table is not mutated: the same ref still falls through to the default price.
    expect(priceFor(pricing, { provider: 'openrouter', model: 'vendor/model' })).toEqual(
      pricing.defaultPrice,
    )
  })

  it('returns the base table untouched for an empty catalog', () => {
    expect(withDynamicPrices(pricing, [])).toBe(pricing)
  })

  it('SKIPS a model OpenRouter reported no pricing for rather than metering it as free', () => {
    const overlaid = withDynamicPrices(pricing, [meta('vendor/unpriced', 0, 0)])
    expect(priceFor(overlaid, { provider: 'openrouter', model: 'vendor/unpriced' })).toEqual(
      pricing.defaultPrice,
    )
  })

  // The skip is ENTIRELY-unpriced, so it takes BOTH halves to pin: a model priced on one side is
  // real pricing and stays overlaid whichever side that is. Asserting only one half leaves the
  // other comparison free to be anything, including a constant.
  it.each([
    { side: 'output', id: 'vendor/output-only', input: 0, output: 3 },
    { side: 'input', id: 'vendor/input-only', input: 5, output: 0 },
  ])('overlays a model priced on the $side side only', ({ id, input, output }) => {
    const overlaid = withDynamicPrices(pricing, [meta(id, input, output)])
    expect(priceFor(overlaid, { provider: 'openrouter', model: id })).toEqual({
      inputPerMillion: input,
      outputPerMillion: output,
    })
  })
})

describe('budgetCapsOverlay', () => {
  it('applies each cap independently', () => {
    expect(budgetCapsOverlay(500, undefined)).toEqual({ accountMonthlyLimitCap: 500 })
    expect(budgetCapsOverlay(undefined, 20)).toEqual({ userMonthlyLimitCap: 20 })
  })

  it('leaves a tier uncapped for a missing or non-finite value', () => {
    expect(budgetCapsOverlay(undefined, undefined)).toEqual({})
    expect(budgetCapsOverlay(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({})
  })

  it('treats 0 as a real ceiling and a negative value as invalid', () => {
    expect(budgetCapsOverlay(0, -1)).toEqual({ accountMonthlyLimitCap: 0 })
  })
})

describe('billing period boundaries', () => {
  it('starts the period at the first instant of the UTC month', () => {
    expect(startOfMonthUtc(Date.UTC(2026, 6, 17, 13, 45, 30, 123))).toBe(Date.UTC(2026, 6, 1))
    // Already at the boundary: idempotent, not pushed back a month.
    expect(startOfMonthUtc(Date.UTC(2026, 6, 1))).toBe(Date.UTC(2026, 6, 1))
  })

  it('ends it at the first instant of the NEXT UTC month, wrapping the year in December', () => {
    expect(startOfNextMonthUtc(Date.UTC(2026, 6, 17))).toBe(Date.UTC(2026, 7, 1))
    expect(startOfNextMonthUtc(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe(Date.UTC(2027, 0, 1))
  })

  it('bounds the period the forecast extrapolates over', () => {
    const now = Date.UTC(2026, 1, 10)
    expect(startOfNextMonthUtc(startOfMonthUtc(now))).toBe(Date.UTC(2026, 2, 1))
  })
})

describe('DEFAULT_SPEND_PRICING', () => {
  it('prices an unknown provider at the default rate rather than at zero', () => {
    const price = priceFor(DEFAULT_SPEND_PRICING, { provider: 'unknown', model: 'x' })
    expect(price).toEqual(DEFAULT_SPEND_PRICING.defaultPrice)
    expect(price.inputPerMillion).toBeGreaterThan(0)
    expect(price.outputPerMillion).toBeGreaterThan(0)
  })
})
