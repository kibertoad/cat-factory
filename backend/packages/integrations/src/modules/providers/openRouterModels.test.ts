import { describe, expect, it } from 'vitest'
import { parseOpenRouterModels } from './openRouterModels.js'

/** USD, so every expectation below reads as the rate OpenRouter itself publishes. */
const USD = 1

/** One `/models` entry with the shape and units OpenRouter actually serves (USD per token). */
function entry(pricing: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return { id: 'vendor/model', name: 'Vendor Model', pricing, ...extra }
}

describe('parseOpenRouterModels', () => {
  it('converts USD per token to spend currency per million', () => {
    const [model] = parseOpenRouterModels(
      [entry({ prompt: '0.000003', completion: '0.000015' })],
      USD,
    )
    expect(model).toMatchObject({ inputPerMillion: 3, outputPerMillion: 15 })
  })

  it('applies the spend-currency rate to every class', () => {
    const [model] = parseOpenRouterModels(
      [entry({ prompt: '0.000002', completion: '0.00001', input_cache_read: '0.0000002' })],
      0.5,
    )
    expect(model).toMatchObject({
      inputPerMillion: 1,
      outputPerMillion: 5,
      cachedInputPerMillion: 0.1,
    })
  })

  // The reason overrides are read at all: a conditional band re-prices a long prompt, and which
  // band applies is unknown when the catalog is refreshed. Budgeting the cheap one is the
  // undercount a spend safeguard may not make.
  it('budgets against the dearest conditional band, not the base rate', () => {
    const [model] = parseOpenRouterModels(
      [
        entry({
          prompt: '0.000001',
          completion: '0.000004',
          overrides: [
            { min_prompt_tokens: 200_000, prompt: '0.000002', completion: '0.000008' },
            { utc_start: 0, utc_end: 6, prompt: '0.0000005' },
          ],
        }),
      ],
      USD,
    )
    expect(model).toMatchObject({ inputPerMillion: 2, outputPerMillion: 8 })
  })

  it('reads the cache classes when published and omits them when not', () => {
    const [priced] = parseOpenRouterModels(
      [
        entry({
          prompt: '0.000003',
          completion: '0.000015',
          input_cache_read: '0.0000003',
          input_cache_write: '0.00000375',
        }),
      ],
      USD,
    )
    expect(priced).toMatchObject({ cachedInputPerMillion: 0.3, cacheWritePerMillion: 3.75 })

    const [unpriced] = parseOpenRouterModels(
      [entry({ prompt: '0.000003', completion: '0.000015' })],
      USD,
    )
    // Absent, NOT zero: the spend table's multiplier fallback is what should apply, and a stored
    // 0 would meter every cache hit as free.
    expect(unpriced).not.toHaveProperty('cachedInputPerMillion')
    expect(unpriced).not.toHaveProperty('cacheWritePerMillion')
  })

  // The one place a max-fold is deliberately NOT used: the TTL our harnesses request is known.
  it('prefers the 5-minute cache-write rate and falls back to the 1-hour one', () => {
    const [both] = parseOpenRouterModels(
      [
        entry({
          prompt: '0.000003',
          completion: '0.000015',
          input_cache_write: '0.00000375',
          input_cache_write_1h: '0.000006',
        }),
      ],
      USD,
    )
    expect(both).toMatchObject({ cacheWritePerMillion: 3.75 })

    const [longOnly] = parseOpenRouterModels(
      [entry({ prompt: '0.000003', completion: '0.000015', input_cache_write_1h: '0.000006' })],
      USD,
    )
    expect(longOnly).toMatchObject({ cacheWritePerMillion: 6 })
  })

  it('applies an account discount to every rate', () => {
    const [model] = parseOpenRouterModels(
      [
        entry({
          prompt: '0.000004',
          completion: '0.00002',
          input_cache_read: '0.0000004',
          discount: 0.25,
        }),
      ],
      USD,
    )
    expect(model).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
      cachedInputPerMillion: 0.3,
    })
  })

  it('ignores a discount outside the 0..1 fraction it is documented as', () => {
    for (const discount of [1.5, -0.2, 'half', null]) {
      const [model] = parseOpenRouterModels(
        [entry({ prompt: '0.000004', completion: '0.00002', discount })],
        USD,
      )
      expect(model).toMatchObject({ inputPerMillion: 4, outputPerMillion: 20 })
    }
  })

  it('keeps a published free rate as free and an unpriced model at zero', () => {
    const [free] = parseOpenRouterModels([entry({ prompt: '0', completion: '0' })], USD)
    expect(free).toMatchObject({ inputPerMillion: 0, outputPerMillion: 0 })

    // No `pricing` at all: the zero is what `withDynamicPrices` reads to SKIP the overlay and
    // keep the conservative bare-`openrouter` fallback, so it must stay a zero rather than
    // becoming an absent field.
    const [unpriced] = parseOpenRouterModels([{ id: 'vendor/model' }], USD)
    expect(unpriced).toMatchObject({ inputPerMillion: 0, outputPerMillion: 0 })
  })

  it('carries the withdrawal date and a canonical slug that differs from the id', () => {
    const [model] = parseOpenRouterModels(
      [
        entry(
          { prompt: '0.000001', completion: '0.000002' },
          {
            expiration_date: '2027-01-31',
            canonical_slug: 'vendor/model-2026-08-01',
            context_length: 200_000,
          },
        ),
      ],
      USD,
    )
    expect(model).toMatchObject({
      expirationDate: '2027-01-31',
      canonicalSlug: 'vendor/model-2026-08-01',
      contextLength: 200_000,
    })

    const [same] = parseOpenRouterModels(
      [entry({ prompt: '0.000001', completion: '0.000002' }, { canonical_slug: 'vendor/model' })],
      USD,
    )
    expect(same).not.toHaveProperty('canonicalSlug')
  })

  it('drops an entry with no usable id and tolerates a non-array payload', () => {
    expect(parseOpenRouterModels([{ id: '  ' }, { name: 'nameless' }], USD)).toEqual([])
    expect(parseOpenRouterModels({ data: [] }, USD)).toEqual([])
    expect(parseOpenRouterModels(null, USD)).toEqual([])
  })

  it('falls back to the id when the catalog names no display name', () => {
    const [model] = parseOpenRouterModels([{ id: 'vendor/model', pricing: {} }], USD)
    expect(model?.name).toBe('vendor/model')
  })
})
