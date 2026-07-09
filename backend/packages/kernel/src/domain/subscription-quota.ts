// Pure vocabulary for subscription quota-cycle modeling (usage-and-quota-tracking, Part B):
// the rolling-window catalog and the modeled per-vendor token ceilings. Kept out of the
// provider so both the composite provider and any UI/reporting layer share one source of
// truth for window lengths + ceilings.

import type { SubscriptionVendor } from '@cat-factory/contracts'
import { ALL_SUBSCRIPTION_VENDORS } from './models.js'
import type { SubscriptionQuotaWindowKind } from '../ports/subscription-quota-repositories.js'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * The rolling windows every subscription quota cycle is modeled over, with each window's
 * length in ms. Vendors advertise a short (~5h) window plus a weekly cap; both accumulate
 * the same tokens but reset on their own cadence. Ordered shortest-first.
 */
export const SUBSCRIPTION_QUOTA_WINDOWS: { kind: SubscriptionQuotaWindowKind; ms: number }[] = [
  { kind: '5h', ms: 5 * HOUR_MS },
  { kind: 'weekly', ms: 7 * DAY_MS },
]

/** The window length in ms for a given kind. */
export function subscriptionQuotaWindowMs(kind: SubscriptionQuotaWindowKind): number {
  return SUBSCRIPTION_QUOTA_WINDOWS.find((w) => w.kind === kind)?.ms ?? 5 * HOUR_MS
}

/**
 * MODELED per-vendor token ceilings (total input + output) for each window, used purely to
 * render a "how much of the quota cycle is left" progress bar.
 *
 * These are best-effort ESTIMATES: NO subscription vendor publishes an absolute token cap
 * (only relative percentages), so a modeled cycle can only approximate one. They are
 * illustrative, NEVER billed, and are the fallback used until Part B2 wires the real
 * vendor reads (Claude `/api/oauth/usage`, GLM `/api/monitor/usage/quota/limit`) — at
 * which point a real read supersedes the model for that vendor. A `null` ceiling means
 * "no modeled cap" → the cycle reports usage + reset time but no percentage. A deployment
 * can override these via the provider's `ceilings` option.
 */
export const SUBSCRIPTION_QUOTA_CEILINGS: Record<
  SubscriptionVendor,
  Record<SubscriptionQuotaWindowKind, number | null>
> = {
  claude: { '5h': 15_000_000, weekly: 300_000_000 },
  codex: { '5h': 10_000_000, weekly: 200_000_000 },
  glm: { '5h': 12_000_000, weekly: 240_000_000 },
  kimi: { '5h': 8_000_000, weekly: 160_000_000 },
  deepseek: { '5h': 8_000_000, weekly: 160_000_000 },
}

/**
 * The modeled ceiling for a (vendor, window), or `null` when unknown. Falls back to `null`
 * for a vendor with no configured ceiling rather than throwing, so a new vendor degrades
 * gracefully (usage + reset, no percentage) until a ceiling is added.
 */
export function subscriptionQuotaCeiling(
  vendor: SubscriptionVendor,
  kind: SubscriptionQuotaWindowKind,
  overrides?: Partial<
    Record<SubscriptionVendor, Partial<Record<SubscriptionQuotaWindowKind, number | null>>>
  >,
): number | null {
  const overridden = overrides?.[vendor]?.[kind]
  if (overridden !== undefined) return overridden
  return SUBSCRIPTION_QUOTA_CEILINGS[vendor]?.[kind] ?? null
}

/** Guard: is `value` one of the known subscription vendors? */
export function isSubscriptionVendor(
  value: string | undefined | null,
): value is SubscriptionVendor {
  return value != null && (ALL_SUBSCRIPTION_VENDORS as string[]).includes(value)
}
