import { DEFAULT_SPEND_PRICING, type SpendPricing, budgetCapsOverlay } from '@cat-factory/spend'
import type { Env } from '../env'
import { num } from './utils'

/**
 * The deployment-level BASE pricing (built-in model price table + the fallback
 * currency/monthly-limit a workspace inherits when it sets no budget of its own). The
 * per-workspace budget — currency, monthly limit, and per-model price overrides — moved
 * out of env (`SPEND_*`) onto the workspace settings row; the spend service overlays a
 * workspace's overrides on top of this base. See `mergeSpendPricing`.
 *
 * The operator env caps (`BUDGET_MAX_MONTHLY_PER_ACCOUNT` / `BUDGET_MAX_MONTHLY_PER_USER`)
 * ceiling the account/user budget tiers — see docs/environment-variables.md.
 */
export function loadSpendPricing(env: Env): SpendPricing {
  return {
    ...DEFAULT_SPEND_PRICING,
    ...budgetCapsOverlay(
      num(env.BUDGET_MAX_MONTHLY_PER_ACCOUNT),
      num(env.BUDGET_MAX_MONTHLY_PER_USER),
    ),
  }
}
