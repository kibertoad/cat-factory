import { UnavailableError, ValidationError } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import {
  coercePrAssessment,
  evaluatePrAssessmentVerdict,
  selectAssessmentPolicy,
  type PrAssessmentPolicy,
} from './prAssessment.logic.js'

const POLICY: PrAssessmentPolicy = {
  id: 'rp_balanced',
  name: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.6,
  autoMergeEnabled: true,
  classRules: {},
  classRulesByRole: {},
  dryRunRoles: [],
  submissionClassesByRole: {},
}

const LOW = { complexity: 0.1, risk: 0.1, impact: 0.1, rationale: 'A one-line docs fix.' }

describe('evaluatePrAssessmentVerdict', () => {
  it('lands a credible assessment within every ceiling', () => {
    expect(evaluatePrAssessmentVerdict(POLICY, LOW, 'source', null)).toEqual({
      outcome: 'within_policy',
      reason: 'within_thresholds',
      exceededAxes: [],
    })
  })

  it('names every axis over its ceiling', () => {
    const high = { ...LOW, complexity: 0.9, impact: 0.61 }
    expect(evaluatePrAssessmentVerdict(POLICY, high, 'source', null)).toEqual({
      outcome: 'requires_review',
      reason: 'exceeded_thresholds',
      exceededAxes: ['complexity', 'impact'],
    })
  })

  it('treats a score equal to its ceiling as within it', () => {
    const atCeiling = { ...LOW, complexity: 0.5, risk: 0.4, impact: 0.6 }
    expect(evaluatePrAssessmentVerdict(POLICY, atCeiling, 'source', null).outcome).toBe(
      'within_policy',
    )
  })

  it('does not trust scores the model did not explain', () => {
    expect(
      evaluatePrAssessmentVerdict(POLICY, { ...LOW, rationale: '  ' }, 'source', null),
    ).toEqual({
      outcome: 'requires_review',
      reason: 'no_rationale',
      exceededAxes: [],
    })
  })

  it('holds everything for a person when the master switch is off, class rules included', () => {
    const manual = { ...POLICY, autoMergeEnabled: false, classRules: { docs: 'always' as const } }
    expect(evaluatePrAssessmentVerdict(manual, LOW, 'docs', null)).toMatchObject({
      outcome: 'requires_review',
      reason: 'auto_merge_disabled',
    })
  })

  it('lets an `always` class rule land a PR whatever its scores', () => {
    const policy = { ...POLICY, classRules: { dependency: 'always' as const } }
    const high = { complexity: 1, risk: 1, impact: 1, rationale: '' }
    expect(evaluatePrAssessmentVerdict(policy, high, 'dependency', null)).toEqual({
      outcome: 'within_policy',
      reason: 'class_auto_merge',
      exceededAxes: [],
    })
  })

  it('holds a `never` class for a person however low its scores', () => {
    const policy = { ...POLICY, classRules: { schema: 'never' as const } }
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'schema', null)).toMatchObject({
      outcome: 'requires_review',
      reason: 'class_requires_review',
    })
  })

  it('falls back to the ceilings for an unclassifiable diff', () => {
    const policy = { ...POLICY, classRules: { source: 'never' as const } }
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'unknown', null).reason).toBe(
      'within_thresholds',
    )
  })

  it('sandboxes a role the policy runs dry, whatever the scores', () => {
    const policy = { ...POLICY, dryRunRoles: ['member' as const] }
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'docs', 'member')).toEqual({
      outcome: 'requires_review',
      reason: 'dry_run',
      exceededAxes: [],
    })
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'docs', null).outcome).toBe('within_policy')
  })

  it('refuses a class outside the submission allowlist of the role', () => {
    const policy = { ...POLICY, submissionClassesByRole: { member: ['docs' as const] } }
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'source', 'member').reason).toBe(
      'submission_not_allowed',
    )
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'docs', 'member').outcome).toBe('within_policy')
  })

  it('names the role when its class rule is what holds the PR', () => {
    const policy = { ...POLICY, classRulesByRole: { member: { docs: 'never' as const } } }
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'docs', 'member').reason).toBe(
      'role_requires_review',
    )
    expect(evaluatePrAssessmentVerdict(policy, LOW, 'docs', 'admin').outcome).toBe('within_policy')
  })
})

describe('selectAssessmentPolicy', () => {
  const library = [
    { ...POLICY, id: 'rp_a', isDefault: true, isUnattendedDefault: false },
    { ...POLICY, id: 'rp_b', isDefault: false, isUnattendedDefault: true },
  ]

  it('resolves the unattended default when no policy is named', () => {
    expect(selectAssessmentPolicy(library, undefined).id).toBe('rp_b')
  })

  it('resolves a named policy', () => {
    expect(selectAssessmentPolicy(library, 'rp_a').id).toBe('rp_a')
  })

  it('refuses an id the library does not hold rather than using the default', () => {
    expect(() => selectAssessmentPolicy(library, 'rp_typo')).toThrow(ValidationError)
    expect(() => selectAssessmentPolicy(library, 'rp_typo')).toThrow(
      expect.objectContaining({ details: { reason: 'risk_policy_not_found' } }),
    )
  })

  it('says so when no policy is the unattended default', () => {
    expect(() => selectAssessmentPolicy([library[0]!], undefined)).toThrow(UnavailableError)
  })
})

describe('coercePrAssessment', () => {
  it('accepts the triage contract', () => {
    expect(coercePrAssessment(LOW)).toEqual(LOW)
  })

  it('refuses a score outside 0..1 and a reply that is not an object', () => {
    expect(coercePrAssessment({ ...LOW, risk: 1.5 })).toBeNull()
    expect(coercePrAssessment('low risk')).toBeNull()
    expect(coercePrAssessment(null)).toBeNull()
  })
})
