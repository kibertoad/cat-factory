import { describe, expect, it } from 'vitest'
import { usageAttributionOf, usageBillingFields } from './usage-attribution.js'

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

  it('trims the vendor it answers with', () => {
    // Stored as the usage report groups by it. A padded vendor is its own group, so the plan's
    // rows would split across two labels that render identically.
    expect(
      usageAttributionOf({ usageAttribution: { billing: 'subscription', vendor: ' claude ' } }),
    ).toEqual({ billing: 'subscription', vendor: 'claude' })
  })

  it('degrades rather than throwing on a malformed declaration', () => {
    // The parameter is `unknown` because that is what the reader has: the AI SDK model union
    // says nothing about markers, and a provider package this repo does not own may put anything
    // on the property. A `TypeError` here would sink a step that only wanted to report tokens.
    expect(usageAttributionOf({ usageAttribution: { billing: 'subscription' } })).toBeUndefined()
    expect(usageAttributionOf({ usageAttribution: { vendor: 'claude' } })).toBeUndefined()
    expect(usageAttributionOf({ usageAttribution: 'subscription' })).toBeUndefined()
    expect(
      usageAttributionOf({ usageAttribution: { billing: 'invoiced', vendor: 'claude' } }),
    ).toBeUndefined()
    expect(
      usageAttributionOf({ usageAttribution: { billing: 'subscription', vendor: 7 } }),
    ).toBeUndefined()
  })
})

// The reduction both inline executors report through. A single-actor step hands it the one model
// it was given; a consensus panel hands it every model behind the usage it sums.

describe('usageBillingFields', () => {
  const subscription = (vendor: string) => ({
    usageAttribution: { billing: 'subscription' as const, vendor },
  })

  it('reports what one model declares', () => {
    expect(usageBillingFields([subscription('claude')])).toEqual({
      usageBilling: 'subscription',
      usageVendor: 'claude',
    })
  })

  it('reports the attribution a panel agrees on', () => {
    expect(usageBillingFields([subscription('claude'), subscription('claude')])).toEqual({
      usageBilling: 'subscription',
      usageVendor: 'claude',
    })
  })

  it('reports nothing for a panel whose models disagree', () => {
    // One ledger row cannot state two billing kinds. A mixed panel spent real money on the
    // metered half, so it stays on the ledger default that keeps that money in the budget gate;
    // claiming the subscription half would hide a cost the workspace is actually paying.
    expect(usageBillingFields([subscription('claude'), {}])).toEqual({})
    expect(usageBillingFields([{}, subscription('claude')])).toEqual({})
    expect(usageBillingFields([subscription('claude'), subscription('codex')])).toEqual({})
  })

  it('reports nothing when there is nothing to agree about', () => {
    expect(usageBillingFields([])).toEqual({})
    expect(usageBillingFields([{}])).toEqual({})
  })
})
