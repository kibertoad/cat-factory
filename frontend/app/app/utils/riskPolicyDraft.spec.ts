import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import { createRiskPolicySchema } from '@cat-factory/contracts'
import type { RiskPolicy } from '~/types/merge'
import {
  blankRiskPolicyDraft,
  riskPolicyPatchFromDraft,
  toRiskPolicyDraft,
  type RiskPolicyDraft,
} from '~/utils/riskPolicyDraft'

// The conversions either side of the policy editor's form state. They are worth their own spec
// because the way they break is SILENT: a field the draft carries but nothing maps into the patch
// renders a control that accepts an operator's edit, PATCHes without it, and re-renders the old
// value with no error anywhere to say the save dropped something.

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
    companionMaxReworks: 3,
    releaseWatchWindowMinutes: 30,
    releaseMaxAttempts: 1,
    humanReviewGraceMinutes: 10,
    judgeMinScore: 0.7,
    judgeMaxBounces: 2,
    autoMergeEnabled: true,
    autonomy: 'attended',
    minAutoAnswerConfidence: 0.8,
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    submissionClassesByRole: {},
    isDefault: true,
    isUnattendedDefault: false,
    version: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }) as RiskPolicy

/**
 * A different value of the same type, whatever the field holds. Generic on purpose: the assertion
 * below iterates the draft's own keys, so it must not know which of them are numbers.
 */
function nudge(value: unknown): unknown {
  if (typeof value === 'number') return value + 1
  if (typeof value === 'boolean') return !value
  if (typeof value === 'string') {
    if (value === 'run') return 'skip'
    if (value === 'none') return 'high'
    return `${value} (edited)`
  }
  if (Array.isArray(value)) return ['admin']
  return { feature: { maxRisk: 0.1 } }
}

describe('the risk-policy draft conversions', () => {
  it('carries every field the draft holds into the patch body', () => {
    // Iterating the draft's OWN keys is what makes this hold for a field added later: the interface
    // is what a new control is added to, and anything on it that `riskPolicyPatchFromDraft` forgets
    // fails here rather than in production.
    const base = toRiskPolicyDraft(policy())
    const unchanged = riskPolicyPatchFromDraft(base, 'Balanced')
    for (const key of Object.keys(base) as (keyof RiskPolicyDraft)[]) {
      const edited = { ...base, [key]: nudge(base[key]) } as RiskPolicyDraft
      expect(
        riskPolicyPatchFromDraft(edited, 'Balanced'),
        `draft field '${key}' never reaches the patch body`,
      ).not.toEqual(unchanged)
    }
  })

  it('round-trips a stored policy unchanged when nothing is edited', () => {
    const stored = policy({ companionMaxReworks: 7, maxRisk: 0.45, autonomy: 'unattended' })
    const patch = riskPolicyPatchFromDraft(toRiskPolicyDraft(stored), 'fallback')

    // The percentages went up by a hundred for editing and came back down; the counts and the
    // posture are stored as typed.
    expect(patch.maxRisk).toBe(0.45)
    expect(patch.minAutoAnswerConfidence).toBe(0.8)
    expect(patch.companionMaxReworks).toBe(7)
    expect(patch.autonomy).toBe('unattended')
  })

  it('keeps a blanked name from saving over the stored one', () => {
    const draft = { ...toRiskPolicyDraft(policy()), name: '   ' }
    expect(riskPolicyPatchFromDraft(draft, 'Balanced').name).toBe('Balanced')
  })

  it('opens the create form on the value the API would have defaulted to', () => {
    // Read off the create schema rather than restated, so a shipped default that moves takes the
    // blank form with it instead of leaving it pre-filling a number nothing else states.
    expect(blankRiskPolicyDraft().companionMaxReworks).toBe(
      v.getDefault(createRiskPolicySchema.entries.companionMaxReworks),
    )
  })

  it('never opens the create form on a granted licence', () => {
    // The one default the blank form may NOT inherit from anywhere: an unattended posture is
    // something a person grants, so a new policy parks on its own caps.
    expect(blankRiskPolicyDraft().unattended).toBe(false)
  })
})
