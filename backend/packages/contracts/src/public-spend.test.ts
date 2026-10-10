import { describe, expect, it } from 'vitest'
import {
  reportSpendDimensionSchema,
  reportSpendSourceSchema,
  reportWindowSchema,
} from './reports.js'
import {
  PUBLIC_SPEND_DIMENSIONS_OMITTED,
  publicSpendDimensionSchema,
  publicSpendSourceSchema,
  publicSpendWindowSchema,
} from './public-spend.js'

// The public spend surface publishes a SUBSET of the dimensions the internal reports port groups
// by, and the subset is a decision rather than an accident. What has to hold is that the decision
// was MADE for every member: a dimension added internally must be either published here or
// explained in the omission map, or it goes missing from four generated SDKs with nothing saying
// why.
//
// Derived from the internal picklist rather than pinned to a count, per the repo's rule about
// asserting a relation over a population the test does not own: `toBe(8)` would fail on every
// ordinary addition, name nothing about what broke, and train the next reader to re-pin it unread.

describe('public spend dimensions', () => {
  it('accounts for every internal spend dimension EXACTLY ONCE', () => {
    const published = new Set<string>(publicSpendDimensionSchema.options)
    const omitted = new Set(Object.keys(PUBLIC_SPEND_DIMENSIONS_OMITTED))
    for (const dimension of reportSpendDimensionSchema.options) {
      expect(
        [published.has(dimension), omitted.has(dimension)].filter(Boolean),
        `spend dimension '${dimension}' must be published on /api/v1/usage/spend or named in ` +
          'PUBLIC_SPEND_DIMENSIONS_OMITTED with the reason',
      ).toHaveLength(1)
      published.delete(dimension)
      omitted.delete(dimension)
    }
    // Nothing on either list that the internal vocabulary no longer has: a published dimension
    // the port cannot group by would be a 500 on a documented request, and a stale omission
    // entry is an explanation for an absence nobody would notice.
    expect([...published, ...omitted]).toEqual([])
  })

  it('states a REASON for each omission, not merely the name', () => {
    for (const [dimension, reason] of Object.entries(PUBLIC_SPEND_DIMENSIONS_OMITTED)) {
      expect(reason.length, `omitted dimension '${dimension}' carries no reason`).toBeGreaterThan(
        40,
      )
    }
  })
})

// The window and source vocabularies are DECLARED on the public contract rather than aliased off
// the internal report ones, because everything `/api/v1` publishes is frozen and an internal
// analytics picklist is not. What that costs is the risk of the two drifting silently, which is
// what these assertions buy back: they turn an internal edit into a failure naming the public
// contract, where the fix is a deliberate `/api/v1` decision (publish the new member, or state
// that the surface deliberately does not).
//
// Set equality, not a count and not `toEqual` on the arrays: member ORDER is not a fact either
// side promises, and a pinned length would fail on every ordinary addition while naming nothing.

describe('public spend vocabularies', () => {
  it('publishes exactly the internal report windows', () => {
    expect([...publicSpendWindowSchema.options].sort()).toEqual(
      [...reportWindowSchema.options].sort(),
    )
  })

  it('publishes exactly the internal spend sources', () => {
    expect([...publicSpendSourceSchema.options].sort()).toEqual(
      [...reportSpendSourceSchema.options].sort(),
    )
  })
})
