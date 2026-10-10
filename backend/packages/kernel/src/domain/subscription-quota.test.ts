import { describe, expect, it } from 'vitest'
import {
  SUBSCRIPTION_QUOTA_CEILINGS,
  SUBSCRIPTION_QUOTA_WINDOWS,
  isSubscriptionVendor,
  subscriptionQuotaCeiling,
  subscriptionQuotaWindowMs,
} from './subscription-quota.js'
import { ALL_SUBSCRIPTION_VENDORS } from './models.js'

// The modeled quota cycle. Every number here is illustrative and never billed, but the SHAPE
// matters: an unknown ceiling has to stay `null` (usage + reset, no percentage) rather than
// becoming a plausible-looking bar nobody can act on.

describe('SUBSCRIPTION_QUOTA_WINDOWS', () => {
  it('is ordered shortest-first, and every window has a real length', () => {
    const lengths = SUBSCRIPTION_QUOTA_WINDOWS.map((w) => w.ms)
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b))
    for (const ms of lengths) expect(ms).toBeGreaterThan(0)
  })

  it('resolves each declared window’s length', () => {
    for (const { kind, ms } of SUBSCRIPTION_QUOTA_WINDOWS) {
      expect(subscriptionQuotaWindowMs(kind)).toBe(ms)
    }
    expect(subscriptionQuotaWindowMs('5h')).toBe(5 * 60 * 60 * 1000)
    expect(subscriptionQuotaWindowMs('weekly')).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it('falls back to the SHORT window for an unknown kind', () => {
    // The conservative direction: a cycle modeled over too short a window resets too often,
    // where a weekly fallback would report a stale bar for days.
    const unknown = subscriptionQuotaWindowMs('monthly' as never)
    expect(unknown).toBe(subscriptionQuotaWindowMs('5h'))
    expect(unknown).toBeLessThan(subscriptionQuotaWindowMs('weekly'))
  })
})

describe('subscriptionQuotaCeiling', () => {
  it('reads the modeled ceiling for a known (vendor, window)', () => {
    expect(subscriptionQuotaCeiling('claude', '5h')).toBe(SUBSCRIPTION_QUOTA_CEILINGS.claude['5h'])
    expect(subscriptionQuotaCeiling('claude', 'weekly')).toBe(
      SUBSCRIPTION_QUOTA_CEILINGS.claude.weekly,
    )
  })

  it('models every shipped vendor with a weekly cap above its short-window one', () => {
    for (const vendor of ALL_SUBSCRIPTION_VENDORS) {
      const ceilings = SUBSCRIPTION_QUOTA_CEILINGS[vendor]
      expect(ceilings).toBeDefined()
      const short = ceilings['5h']
      const weekly = ceilings.weekly
      if (short != null && weekly != null) expect(weekly).toBeGreaterThan(short)
    }
  })

  it('lets a deployment override one window without disturbing the other', () => {
    const overrides = { claude: { '5h': 1_000 } } as const
    expect(subscriptionQuotaCeiling('claude', '5h', overrides)).toBe(1_000)
    expect(subscriptionQuotaCeiling('claude', 'weekly', overrides)).toBe(
      SUBSCRIPTION_QUOTA_CEILINGS.claude.weekly,
    )
  })

  it('honours an override of null as "no modeled cap", not as absent', () => {
    // An operator who knows the model is wrong for their plan can withdraw the bar, and a
    // fallback to the shipped estimate would ignore them.
    expect(subscriptionQuotaCeiling('claude', '5h', { claude: { '5h': null } })).toBeNull()
  })

  it('degrades an unmodeled vendor to no percentage rather than throwing', () => {
    expect(subscriptionQuotaCeiling('brand-new' as never, '5h')).toBeNull()
  })
})

describe('isSubscriptionVendor', () => {
  it('accepts exactly the shipped vendors', () => {
    for (const vendor of ALL_SUBSCRIPTION_VENDORS) expect(isSubscriptionVendor(vendor)).toBe(true)
  })

  it('rejects an unknown vendor and an absent value', () => {
    expect(isSubscriptionVendor('openai')).toBe(false)
    expect(isSubscriptionVendor('Claude')).toBe(false)
    expect(isSubscriptionVendor('')).toBe(false)
    expect(isSubscriptionVendor(null)).toBe(false)
    expect(isSubscriptionVendor(undefined)).toBe(false)
  })
})
