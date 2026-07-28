import { describe, expect, it } from 'vitest'
import type { RiskPolicy } from '~/types/merge'
import { RISK_POLICY_AXES, RISK_POLICY_CEILING_FIELD, riskPolicyCeilings } from '~/utils/riskPolicy'

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
