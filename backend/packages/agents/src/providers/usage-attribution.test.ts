import { describe, expect, it } from 'vitest'
import { usageAttributionOf } from './usage-attribution.js'

// The reader of the billing marker a resolved model carries. It is one property access plus one
// rule, and the rule is the whole point: HALF an attribution is worse than none, because a
// subscription row whose vendor is blank is exactly the row the usage report could not group and
// nobody could trace back to the plan that paid for it.

describe('usageAttributionOf', () => {
  it('returns what a model declares', () => {
    const model = { usageAttribution: { billing: 'subscription' as const, vendor: 'anthropic' } }
    expect(usageAttributionOf(model)).toEqual({ billing: 'subscription', vendor: 'anthropic' })
  })

  it('answers undefined for a model that declares nothing', () => {
    // A plain metered provider key. The ledger's own default then applies, unchanged.
    expect(usageAttributionOf({})).toBeUndefined()
    expect(usageAttributionOf(null)).toBeUndefined()
  })

  it('refuses a declaration whose vendor is blank', () => {
    // Treated as no declaration rather than as a subscription row with an unusable vendor: the
    // ledger fills the vendor in from the model's provider, which is a fact rather than a blank.
    expect(
      usageAttributionOf({ usageAttribution: { billing: 'subscription', vendor: '  ' } }),
    ).toBeUndefined()
  })
})
