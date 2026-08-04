import { describe, expect, it } from 'vitest'
import type { RiskPolicy } from '~/types/merge'
import {
  RISK_POLICY_AXES,
  RISK_POLICY_CEILING_FIELD,
  riskPolicyCeilings,
  rolePolicySummary,
} from '~/utils/riskPolicy'

const policy = (over: Partial<RiskPolicy> = {}): RiskPolicy =>
  ({
    id: 'mp_balanced',
    name: 'Balanced',
    maxComplexity: 0.6,
    maxRisk: 0.4,
    maxImpact: 0.5,
    ciMaxAttempts: 10,
    maxRequirementIterations: 6,
    maxRequirementConcernAllowed: 'none',
    maxTesterQualityIterations: 3,
    releaseWatchWindowMinutes: 30,
    releaseMaxAttempts: 1,
    humanReviewGraceMinutes: 10,
    judgeMinScore: 0.7,
    judgeMaxBounces: 2,
    autoMergeEnabled: true,
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    isDefault: true,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as RiskPolicy

describe('riskPolicyCeilings', () => {
  it('groups the three axes in presentation order', () => {
    expect(riskPolicyCeilings(policy()).map((c) => c.axis)).toEqual([
      'risk',
      'impact',
      'complexity',
    ])
  })

  it('carries each axis ceiling as the stored 0..1 ratio', () => {
    expect(riskPolicyCeilings(policy())).toEqual([
      { axis: 'risk', max: 0.4 },
      { axis: 'impact', max: 0.5 },
      { axis: 'complexity', max: 0.6 },
    ])
  })

  it('follows the shared axis order, which the settings editor iterates too', () => {
    // The point of the exported order: the picker preview, the inspector summary and the
    // settings editor all read it, so none of them can drift into its own sequence.
    expect(riskPolicyCeilings(policy()).map((c) => c.axis)).toEqual([...RISK_POLICY_AXES])
    expect(Object.keys(RISK_POLICY_CEILING_FIELD).sort()).toEqual([...RISK_POLICY_AXES].sort())
  })
})

describe('rolePolicySummary', () => {
  it('is empty on a policy that treats every initiator alike', () => {
    expect(rolePolicySummary(policy())).toEqual({ sandboxed: [], narrowed: [] })
  })

  it('lists both layers in the shared role order', () => {
    const p = policy({
      dryRunRoles: ['viewer', 'member'],
      classRulesByRole: { admin: { schema: 'never' } },
    })
    expect(rolePolicySummary(p)).toEqual({
      sandboxed: ['member', 'viewer'],
      narrowed: ['admin'],
    })
  })

  // The sandbox outranks the class rules, so naming both for one role would report a second
  // limit that changes nothing about what that role's runs can do.
  it('does not also report class rules for a role the policy sandboxes', () => {
    const p = policy({ dryRunRoles: ['member'], classRulesByRole: { member: { docs: 'never' } } })
    expect(rolePolicySummary(p)).toEqual({ sandboxed: ['member'], narrowed: [] })
  })
})
