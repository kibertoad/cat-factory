import { describe, expect, it } from 'vitest'
import type { RiskPolicy } from '~/types/merge'
import { riskPolicyCeilings } from '~/utils/riskPolicy'

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

  it('reports the ceilings of a policy that never auto-merges too', () => {
    // Auto-merge off means the ceilings don't apply, but they're still the policy's stored
    // values — the picker decides whether to show them, this helper never filters.
    expect(riskPolicyCeilings(policy({ autoMergeEnabled: false })).map((c) => c.max)).toEqual([
      0.4, 0.5, 0.6,
    ])
  })
})
