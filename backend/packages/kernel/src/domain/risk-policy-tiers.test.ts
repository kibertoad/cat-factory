import { describe, expect, it } from 'vitest'
import {
  describeRiskPolicySuppressions,
  mergeRiskPolicyTiers,
  resolveRiskPolicyTier,
} from './risk-policy-tiers.js'
import { riskPolicyFromSeed, seedRiskPolicies } from './catalog.js'
import type { RiskPolicy } from './types.js'
import type { AccountRiskPolicy } from '../ports/risk-policy-repositories.js'

// The tier merge is where "a board inherits its account's postures" becomes a specific list, and
// every assertion below is about a precedence decision rather than about the numbers on a policy:
// which tier wins a collision, what a suppression may and may not hide, and the fact that the LIST
// merge and the single-id RESOLUTION agree. The last one is the whole reason both live in one file
// (the engine resolves a pin through the second and the editor renders the first).

/** A policy built off a real seed, so the ~20 unrelated fields are the shipped ones. */
function policy(id: string, over: Partial<RiskPolicy> = {}): RiskPolicy {
  const seed = seedRiskPolicies()[0]!
  return { ...riskPolicyFromSeed(seed, 1_000), id, name: id, ...over }
}

function accountPolicy(id: string, over: Partial<AccountRiskPolicy> = {}): AccountRiskPolicy {
  const { isDefault: _d, isUnattendedDefault: _u, ...rest } = policy(id)
  return { ...rest, ...over }
}

describe('mergeRiskPolicyTiers', () => {
  it('offers the account tier alongside the board own, account first and each tagged', () => {
    const merged = mergeRiskPolicyTiers({
      accountPolicies: [accountPolicy('mp_org')],
      workspacePolicies: [policy('mp_local')],
      suppressedIds: [],
    })
    expect(merged.map((entry) => [entry.id, entry.tier])).toEqual([
      ['mp_org', 'account'],
      ['mp_local', 'workspace'],
    ])
  })

  it('never lets an inherited policy claim a default, whatever the account row says', () => {
    // An account row has no default columns at all, so this pins the LIFT rather than a filter:
    // the merged shape has the two fields and an inherited entry must answer false for both, or a
    // picker would show two in-app defaults and the SPA's `find(p => p.isDefault)` would resolve
    // whichever tier happened to sort first.
    const [inherited] = mergeRiskPolicyTiers({
      accountPolicies: [accountPolicy('mp_org')],
      workspacePolicies: [],
      suppressedIds: [],
    })
    expect(inherited).toMatchObject({ isDefault: false, isUnattendedDefault: false })
  })

  it('lets the board OWN row win a collision, so a tightened built-in survives', () => {
    // Every board is seeded with the built-in ids, so an account authoring `mp_balanced` collides
    // with a row every board already has. A board that tightened its ceilings must keep them.
    const merged = mergeRiskPolicyTiers({
      accountPolicies: [accountPolicy('mp_balanced', { maxRisk: 0.9 })],
      workspacePolicies: [policy('mp_balanced', { maxRisk: 0.1 })],
      suppressedIds: [],
    })
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ tier: 'workspace', maxRisk: 0.1 })
  })

  it('drops a suppressed account policy', () => {
    const merged = mergeRiskPolicyTiers({
      accountPolicies: [accountPolicy('mp_org'), accountPolicy('mp_other')],
      workspacePolicies: [],
      suppressedIds: ['mp_org'],
    })
    expect(merged.map((entry) => entry.id)).toEqual(['mp_other'])
  })

  it('never lets a suppression hide the board OWN policy', () => {
    // A board deletes its own row; it hides an INHERITED one. A stale suppression naming a local id
    // (the account withdrew the policy and the board later authored its own under that id) must say
    // nothing about it, or an id becomes unusable for a reason nothing on screen explains.
    const merged = mergeRiskPolicyTiers({
      accountPolicies: [],
      workspacePolicies: [policy('mp_local')],
      suppressedIds: ['mp_local'],
    })
    expect(merged.map((entry) => entry.id)).toEqual(['mp_local'])
  })

  it('is the board own library when there is no account', () => {
    const merged = mergeRiskPolicyTiers({
      accountPolicies: [],
      workspacePolicies: [policy('mp_a'), policy('mp_b')],
      suppressedIds: [],
    })
    expect(merged.map((entry) => entry.tier)).toEqual(['workspace', 'workspace'])
  })
})

describe('resolveRiskPolicyTier', () => {
  it('answers the same tier the list merge would, for every combination of the two rows', () => {
    // The property that matters is agreement with `mergeRiskPolicyTiers`, so it is derived from
    // that function rather than restated: the engine resolves a pin through this one and the
    // editor renders the other, and a divergence would decide how much oversight a merge takes
    // by a rule nobody could see.
    const workspacePolicies = [[], [policy('mp_x', { maxRisk: 0.1 })]] as const
    const accountPolicies = [[], [accountPolicy('mp_x', { maxRisk: 0.9 })]] as const
    for (const own of workspacePolicies) {
      for (const inherited of accountPolicies) {
        for (const suppressed of [false, true]) {
          const suppressedIds = suppressed ? ['mp_x'] : []
          const expected =
            mergeRiskPolicyTiers({
              accountPolicies: inherited,
              workspacePolicies: own,
              suppressedIds,
            }).find((entry) => entry.id === 'mp_x') ?? null
          const resolved = resolveRiskPolicyTier({
            workspacePolicy: own[0] ?? null,
            accountPolicy: inherited[0] ?? null,
            suppressed,
          })
          expect(
            resolved,
            JSON.stringify({ own: own.length, inherited: inherited.length, suppressed }),
          ).toEqual(expected)
        }
      }
    }
  })

  it('resolves nothing when neither tier defines the id', () => {
    expect(
      resolveRiskPolicyTier({ workspacePolicy: null, accountPolicy: null, suppressed: false }),
    ).toBeNull()
  })
})

describe('describeRiskPolicySuppressions', () => {
  it('names the account policy it hides, and says when it hides nothing', () => {
    const described = describeRiskPolicySuppressions(
      ['mp_org', 'mp_withdrawn'],
      [accountPolicy('mp_org', { name: 'Org standard' })],
    )
    expect(described).toEqual([
      { id: 'mp_org', name: 'Org standard', inherited: true },
      // The account deleted this one, so the suppression withholds nothing today. The id is the
      // only honest name left, and `inherited: false` is what stops a reader concluding a posture
      // is being withheld when there is none to withhold.
      { id: 'mp_withdrawn', name: 'mp_withdrawn', inherited: false },
    ])
  })
})
