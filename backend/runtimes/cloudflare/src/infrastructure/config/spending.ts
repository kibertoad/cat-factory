import { DEFAULT_SPEND_PRICING, type SpendPricing } from '@cat-factory/spend'
import type { Env } from '../env'

/**
 * The deployment-level BASE pricing (built-in model price table + the fallback
 * currency/monthly-limit a workspace inherits when it sets no budget of its own). The
 * per-workspace budget — currency, monthly limit, and per-model price overrides — moved
 * out of env (`SPEND_*`) onto the workspace settings row; the spend service overlays a
 * workspace's overrides on top of this base. See `mergeSpendPricing`.
 */
export function loadSpendPricing(_env: Env): SpendPricing {
  return DEFAULT_SPEND_PRICING
}
