import {
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  type ModelPrice,
  type SpendPricing,
} from '@cat-factory/core'
import type { Env } from '../env'
import { num } from './utils'

function parsePriceOverrides(raw: string | undefined): Record<string, ModelPrice> {
  if (!raw || raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('SPEND_MODEL_PRICES is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) return {}

  const out: Record<string, ModelPrice> = {}
  for (const [key, value] of Object.entries(parsed as Record<string, Record<string, unknown>>)) {
    const input = value.inputPerMillion
    const output = value.outputPerMillion
    if (typeof input !== 'number' || typeof output !== 'number') {
      throw new Error(
        `SPEND_MODEL_PRICES.${key} requires numeric "inputPerMillion" and "outputPerMillion"`,
      )
    }
    out[key] = { inputPerMillion: input, outputPerMillion: output }
  }
  return out
}

export function loadSpendPricing(env: Env): SpendPricing {
  const limit = num(env.SPEND_MONTHLY_LIMIT)
  return {
    currency: env.SPEND_CURRENCY?.trim() || 'EUR',
    monthlyLimit: limit !== undefined && limit >= 0 ? limit : DEFAULT_MONTHLY_LIMIT_EUR,
    // Operator overrides win over the built-in defaults, per key.
    prices: { ...DEFAULT_MODEL_PRICES, ...parsePriceOverrides(env.SPEND_MODEL_PRICES) },
    defaultPrice: { inputPerMillion: 0.14, outputPerMillion: 0.55 },
  }
}
