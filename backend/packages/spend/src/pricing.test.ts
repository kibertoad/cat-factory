import { MODEL_CATALOG, providerCachesPrompts } from '@cat-factory/kernel'
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

  it('meters the shipped Bifrost gateway entry at the rate of the model it routes to', () => {
    // Bifrost names models by their CANONICAL `provider/model` pair, so the shipped catalog entry's
    // real upstream rate IS knowable, and the bare-`bifrost` fallback (a mid-range guess for a
    // route this table cannot resolve) would under-count it by more than an order of magnitude
    // against a workspace budget. Both halves are derived from the catalog entry and the vendor's
    // own row, so repointing the entry fails here rather than silently re-pricing it.
    const entry = MODEL_CATALOG.find((model) => model.id === 'bifrost-default')
    const ref = entry?.direct?.ref
    expect(ref?.provider).toBe('bifrost')
    const [vendor, ...model] = (ref?.model ?? '').split('/')
    expect(vendor && model.length).toBeTruthy()
    const gatewayRate = priceFor(DEFAULT_SPEND_PRICING, ref!)
    expect(gatewayRate).toEqual(
      priceFor(DEFAULT_SPEND_PRICING, { provider: vendor!, model: model.join('/') }),
    )
    expect(gatewayRate).not.toEqual(
      priceFor(DEFAULT_SPEND_PRICING, { provider: 'bifrost', model: 'an-unlisted-route' }),
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

describe('estimateCost', () => {
  it('prices input and output at their own rates and SUMS them', () => {
    const cost = estimateCost(
      pricing,
      { provider: 'acme', model: 'big' },
      { inputTokens: 2_000_000, outputTokens: 500_000 },
    )
    // 2M at 10/M plus 0.5M at 40/M.
    expect(cost).toBeCloseTo(20 + 20)
  })

  it('prices a usage with NO split as FRESH, over-stating a cached call rather than under-stating it', () => {
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

  it('prices per CLASS as soon as the usage carries a split', () => {
    // The whole point of routing inside `estimateCost`: a caller holding a classed usage cannot
    // silently get the lump price by reaching for the wrong function.
    const ref = { provider: 'acme', model: 'cached' }
    const classes = { promptTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 }
    expect(
      estimateCost(pricing, ref, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputClasses: classes,
      }),
    ).toBeCloseTo(estimateClassedCost(pricing, ref, { ...classes, outputTokens: 0 }))
    // 1M cache reads at this entry's stated 3/M, not the 10/M fresh rate the lump would apply.
    expect(
      estimateCost(pricing, ref, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        inputClasses: classes,
      }),
    ).toBeCloseTo(3)
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

// Two tables state something about the same OpenRouter route: this one pins a cache-READ rate
// where the vendor departs from the derived floor, and the cache policy answers whether a cache
// hit HAPPENS on the request this platform sends. A pinned rate is therefore evidence that the
// route bills the class, and the policy answering `false` for one is either deliberate or the bug
// that had every `z-ai/*` slug and the Moonshot one reported as cacheless while the table priced
// their cache reads.
//
// The set of deliberate disagreements is named rather than tolerated as a filter, so a NEW pinned
// slug whose vendor the policy has never been asked about fails here until somebody states the
// answer. Derived from the table itself, so adding a row cannot make the check vacuous.
describe('pinned gateway cache rates against the cache policy', () => {
  /**
   * A pinned cache-read rate the policy deliberately answers `false` for, with the reason.
   * The rate is what the vendor bills IF a hit occurs; the policy is whether one occurs here.
   */
  const CACHE_HIT_UNREACHABLE: Record<string, string> = {
    // OpenRouter's Alibaba route requires explicit `cache_control` breakpoints (the same syntax
    // Anthropic needs) and nothing on the gateway path emits them, so the published rate is real
    // and unreachable. Emitting the breakpoints is what would let this move.
    'qwen/qwen3.8-max': 'Alibaba caches only on explicit breakpoints, which this path never sends',
  }

  const pinnedCacheReadSlugs = Object.entries(DEFAULT_SPEND_PRICING.prices)
    .filter(
      ([ref, price]) => ref.startsWith('openrouter:') && price.cacheReadPerMillion !== undefined,
    )
    .map(([ref]) => ref.slice('openrouter:'.length))

  it('has rows to check', () => {
    // A zero here would make the assertion below vacuous, which is the failure mode of a loop
    // over a filtered table.
    expect(pinnedCacheReadSlugs.length).toBeGreaterThan(0)
  })

  it('accounts for every pinned cache rate: the route caches, or the reason it cannot is named', () => {
    const notCaching = pinnedCacheReadSlugs
      .filter((slug) => !providerCachesPrompts('openrouter', slug))
      .sort()
    expect(notCaching).toEqual(Object.keys(CACHE_HIT_UNREACHABLE).sort())
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

  // The two cache classes are priced an order of magnitude apart in OPPOSITE directions, so a
  // gateway's own published rates beat the derived multipliers wherever it publishes them.
  it('carries the gateway-published cache rates through', () => {
    const overlaid = withDynamicPrices(pricing, [
      {
        ...meta('vendor/cached', 4, 12),
        cachedInputPerMillion: 0.25,
        cacheWritePerMillion: 6,
      } as Parameters<typeof withDynamicPrices>[1][number],
    ])
    expect(priceFor(overlaid, { provider: 'openrouter', model: 'vendor/cached' })).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 12,
      cacheReadPerMillion: 0.25,
      cacheWritePerMillion: 6,
    })
  })

  // Absent must stay absent so `ratesFor` still derives its fallback. Writing a derived multiple
  // into the overlay instead would freeze today's ratio into every stored row and make the
  // gateway's own repricing unreachable, which is what the dynamic path exists for.
  it('leaves an unpublished cache rate to the multiplier fallback', () => {
    const overlaid = withDynamicPrices(pricing, [meta('vendor/plain', 4, 12)])
    const price = priceFor(overlaid, { provider: 'openrouter', model: 'vendor/plain' })
    expect(price).toEqual({ inputPerMillion: 4, outputPerMillion: 12 })
    expect(price).not.toHaveProperty('cacheReadPerMillion')
  })

  // A published zero and a missing rate are indistinguishable in the direction that matters: a
  // gateway that does not bill a class separately lists `"0"` for it, and the catalog's 4-dp
  // rounding turns any real rate below 0.00005/1M into the same zero. Overlaying either would
  // meter every cache hit on that model at nothing.
  it('drops a zero cache rate to the multiplier rather than metering cache hits free', () => {
    const overlaid = withDynamicPrices(pricing, [
      {
        ...meta('vendor/zeroed', 4, 12),
        cachedInputPerMillion: 0,
        cacheWritePerMillion: 0,
      } as Parameters<typeof withDynamicPrices>[1][number],
    ])
    const ref = { provider: 'openrouter', model: 'vendor/zeroed' }
    expect(priceFor(overlaid, ref)).toEqual({ inputPerMillion: 4, outputPerMillion: 12 })
    expect(ratesFor(overlaid, ref)).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 12,
      cacheReadPerMillion: 4 * CACHE_READ_MULTIPLIER,
      cacheWritePerMillion: 4 * CACHE_WRITE_MULTIPLIER,
    })
  })

  it('keeps every base entry beside the overlay rather than replacing the table', () => {
    // The dynamic catalog ADDS OpenRouter slugs; a curated price the deployment already had must
    // still resolve, or every non-OpenRouter model silently falls back to the default price.
    const overlaid = withDynamicPrices(pricing, [meta('vendor/model', 7, 21)])
    expect(priceFor(overlaid, { provider: 'acme', model: 'big' })).toEqual(
      pricing.prices['acme:big'],
    )
    expect(overlaid.currency).toBe(pricing.currency)
    expect(overlaid.monthlyLimit).toBe(pricing.monthlyLimit)
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

  // Each rule is asserted on BOTH sides. The two guards are separate expressions, so a test that
  // only ever puts the bad value on one side leaves the other free to be a constant.
  it('leaves a tier uncapped for a missing or non-finite value', () => {
    // `toEqual` ignores an explicitly-undefined property, so the KEY has to be checked: an
    // overlay carrying `{ accountMonthlyLimitCap: undefined }` overwrites a configured cap.
    expect(Object.keys(budgetCapsOverlay(undefined, undefined))).toEqual([])
    expect(Object.keys(budgetCapsOverlay(Number.NaN, Number.POSITIVE_INFINITY))).toEqual([])
    expect(Object.keys(budgetCapsOverlay(Number.POSITIVE_INFINITY, Number.NaN))).toEqual([])
  })

  it('treats 0 as a real ceiling and a negative value as invalid, on either side', () => {
    expect(budgetCapsOverlay(0, -1)).toEqual({ accountMonthlyLimitCap: 0 })
    expect(budgetCapsOverlay(-1, 0)).toEqual({ userMonthlyLimitCap: 0 })
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
