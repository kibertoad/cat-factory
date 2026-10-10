import { describe, expect, it } from 'vitest'
import { DEFAULT_MODEL_FLAVOR_ORDER, type ModelFlavor } from '@cat-factory/contracts'
import {
  commitFlavorOrder,
  isDefaultFlavorOrder,
  moveFlavor,
  subscriptionOverridesOrder,
} from '~/components/settings/ProviderPreferenceEditor.logic'

const DEFAULT = [...DEFAULT_MODEL_FLAVOR_ORDER]

describe('isDefaultFlavorOrder', () => {
  it('is true only for the full shipped order, position for position', () => {
    expect(isDefaultFlavorOrder(DEFAULT)).toBe(true)
    expect(isDefaultFlavorOrder([...DEFAULT].reverse())).toBe(false)
  })

  it('rejects a PREFIX of the default rather than reading it as "no preference"', () => {
    // `every` is vacuously true for a prefix, so without the length check a partial order that
    // happens to start like the default would be silently cleared — the preset would lose an
    // order the caller meant to store.
    expect(isDefaultFlavorOrder(DEFAULT.slice(0, 2))).toBe(false)
    expect(isDefaultFlavorOrder([])).toBe(false)
  })
})

describe('commitFlavorOrder', () => {
  it('stores an order that equals the default as ABSENT, not as a copy of it', () => {
    // The whole "a preset keeps tracking the shipped order as the product changes it" property
    // rests on this, and the SPA is the only place it happens.
    expect(commitFlavorOrder(DEFAULT)).toBeUndefined()
  })

  it('stores a genuinely reordered list', () => {
    const reordered: ModelFlavor[] = [
      'bedrock',
      'direct',
      'openrouter',
      'cloudflare',
      'subscription',
    ]
    expect(commitFlavorOrder(reordered)).toEqual(reordered)
  })

  it('copies rather than aliasing the array it was given', () => {
    const next: ModelFlavor[] = ['bedrock', 'direct', 'openrouter', 'cloudflare', 'subscription']
    const stored = commitFlavorOrder(next)
    next[0] = 'cloudflare'
    expect(stored?.[0]).toBe('bedrock')
  })
})

describe('moveFlavor', () => {
  it('swaps with the neighbour in the given direction', () => {
    expect(moveFlavor(DEFAULT, 1, -1)).toEqual([DEFAULT[1], DEFAULT[0], ...DEFAULT.slice(2)])
  })

  it('is a no-op past either end', () => {
    expect(moveFlavor(DEFAULT, 0, -1)).toBeUndefined()
    expect(moveFlavor(DEFAULT, DEFAULT.length - 1, 1)).toBeUndefined()
  })

  it('never drops or duplicates a route (a preference reorders, it never filters)', () => {
    const moved = moveFlavor(DEFAULT, 2, 1)!
    expect([...moved].sort()).toEqual([...DEFAULT].sort())
  })
})

describe('subscriptionOverridesOrder', () => {
  const compliance: ModelFlavor[] = ['bedrock', 'direct']
  const subscriptionFirst: ModelFlavor[] = ['subscription', 'direct']

  it('warns whenever a connected plan can overrule the order (the compliance-preset case)', () => {
    // "Subscriptions always win" is applied by the engine ON TOP of the route this order resolves,
    // so a preset promoting AWS Bedrock is silently overruled for a dual-mode model on a workspace
    // holding a token. The control has to say so rather than promise the route.
    expect(subscriptionOverridesOrder({ preference: compliance, hasSubscription: true })).toBe(true)
  })

  it('stays quiet when the order already puts the subscription first (override agrees with it)', () => {
    expect(
      subscriptionOverridesOrder({ preference: subscriptionFirst, hasSubscription: true }),
    ).toBe(false)
  })

  it('stays quiet with no connected subscription — no token, no override', () => {
    expect(subscriptionOverridesOrder({ preference: compliance, hasSubscription: false })).toBe(
      false,
    )
  })

  it('stays quiet when the preset states no order at all (nothing was promised)', () => {
    expect(subscriptionOverridesOrder({ preference: undefined, hasSubscription: true })).toBe(false)
    expect(subscriptionOverridesOrder({ preference: [], hasSubscription: true })).toBe(false)
  })

  it('judges the RESOLVED total order, not the caller’s partial list', () => {
    // A one-entry list still resolves to a full order, so "is subscription first" is answerable
    // for it — and `['subscription']` promotes the route even though it names nothing else.
    expect(
      subscriptionOverridesOrder({ preference: ['subscription'], hasSubscription: true }),
    ).toBe(false)
  })
})
