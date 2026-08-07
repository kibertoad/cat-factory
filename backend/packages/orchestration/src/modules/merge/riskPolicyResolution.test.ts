import { describe, expect, it } from 'vitest'
import type { RiskPolicy, RiskPolicyRepository } from '@cat-factory/kernel'
import { DEFAULT_RISK_POLICY, FALLBACK_RISK_POLICY, seedRiskPolicies } from '@cat-factory/kernel'
import { resolveRiskPolicy } from './riskPolicyResolution.js'

// The UNRESOLVED merge posture. `resolveRiskPolicy` has three exits, and the third one governs a
// run when nobody has stated a policy at all: a deployment that wires no preset library, or a
// board old enough to predate creation-time seeding. That exit auto-merges NOTHING, while the
// shipped `Balanced` preset an operator can pin keeps auto-merge on. The two are deliberately
// different policies, and asserting them together is what stops the fallback drifting back onto
// `Balanced`.

const WS = 'ws1'

function policy(over: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    id: 'mp_custom',
    name: 'Custom',
    maxComplexity: 0.9,
    maxRisk: 0.9,
    maxImpact: 0.9,
    ciMaxAttempts: 3,
    maxRequirementIterations: 4,
    maxRequirementConcernAllowed: 'none',
    maxTesterQualityIterations: 3,
    releaseWatchWindowMinutes: 30,
    releaseMaxAttempts: 1,
    humanReviewGraceMinutes: 10,
    judgeMinScore: 0.7,
    judgeMaxBounces: 1,
    autoMergeEnabled: true,
    classRules: {},
    classRulesByRole: {},
    dryRunRoles: [],
    submissionClassesByRole: {},
    isDefault: false,
    createdAt: 0,
    ...over,
  }
}

function fakeRepo(rows: RiskPolicy[]): RiskPolicyRepository {
  return {
    get: async (_ws, id) => rows.find((r) => r.id === id) ?? null,
    list: async () => rows,
    getDefault: async () => rows.find((r) => r.isDefault) ?? null,
    upsert: async () => {},
    remove: async () => {},
  }
}

describe('resolveRiskPolicy: the unresolved fallback', () => {
  it('refuses to auto-merge when no preset repository is wired', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: 'mp_balanced',
    })
    expect(resolved.autoMergeEnabled).toBe(false)
    // No id: the fallback is a constant, not a row somebody could go and edit.
    expect(resolved.id).toBeUndefined()
    expect(resolved.name).toBe(FALLBACK_RISK_POLICY.name)
  })

  it('refuses to auto-merge when the workspace has seeded no default yet', async () => {
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([]),
      workspaceId: WS,
      riskPolicyId: null,
    })
    expect(resolved.autoMergeEnabled).toBe(false)
  })

  it('refuses when a task pins an id that no longer exists AND there is no default to fall to', async () => {
    // The pin is dangling and the library is empty, so both reads miss and the run lands on the
    // refusing fallback. The seeded case sits in the resolved-preset block below: a dangling pin
    // with a real default falls THROUGH to that default, and pinning both halves is what keeps
    // this one from passing merely because the repository was empty.
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([]),
      workspaceId: WS,
      riskPolicyId: 'mp_deleted',
    })
    expect(resolved.autoMergeEnabled).toBe(false)
    expect(resolved.id).toBeUndefined()
  })

  it('reports ceilings no assessment can pass, so a banner never blames a threshold', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: null,
    })
    expect([resolved.maxComplexity, resolved.maxRisk, resolved.maxImpact]).toEqual([0, 0, 0])
  })

  it('keeps the BUDGET knobs, which are not postures', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: null,
    })
    expect(resolved.ciMaxAttempts).toBe(DEFAULT_RISK_POLICY.ciMaxAttempts)
    expect(resolved.maxRequirementIterations).toBe(DEFAULT_RISK_POLICY.maxRequirementIterations)
    expect(resolved.maxTesterQualityIterations).toBe(DEFAULT_RISK_POLICY.maxTesterQualityIterations)
    expect(resolved.releaseWatchWindowMinutes).toBe(DEFAULT_RISK_POLICY.releaseWatchWindowMinutes)
    expect(resolved.humanReviewGraceMinutes).toBe(DEFAULT_RISK_POLICY.humanReviewGraceMinutes)
  })

  it('holds nobody to a role rule, so the fallback cannot sandbox anyone', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: null,
    })
    expect(resolved.classRules).toBeUndefined()
    expect(resolved.classRulesByRole).toBeUndefined()
    expect(resolved.dryRunRoles).toBeUndefined()
    expect(resolved.submissionClassesByRole).toBeUndefined()
  })
})

describe('resolveRiskPolicy: a resolved preset still governs', () => {
  it('prefers the task pin over the workspace default', async () => {
    const pinned = policy({ id: 'mp_pinned', name: 'Pinned' })
    const dflt = policy({ id: 'mp_default', name: 'Default', isDefault: true })
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([pinned, dflt]),
      workspaceId: WS,
      riskPolicyId: 'mp_pinned',
    })
    expect(resolved.id).toBe('mp_pinned')
  })

  it('uses the workspace default when the task pins nothing', async () => {
    const dflt = policy({ id: 'mp_default', isDefault: true })
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([dflt]),
      workspaceId: WS,
      riskPolicyId: null,
    })
    expect(resolved.id).toBe('mp_default')
    expect(resolved.autoMergeEnabled).toBe(true)
  })

  it('falls THROUGH a dangling pin to the workspace default, not to the refusing fallback', async () => {
    // A pin whose preset was deleted is a stale reference, not a statement that the deployment
    // has no policy: the workspace default is still a policy somebody chose, and it governs.
    // The refusal is for having NO answer, and the board's preset-selection guard resolves
    // through this same function, so the two cannot disagree about which one this is.
    const dflt = policy({ id: 'mp_default', name: 'Default', isDefault: true })
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([dflt]),
      workspaceId: WS,
      riskPolicyId: 'mp_deleted',
    })
    expect(resolved.id).toBe('mp_default')
    expect(resolved.name).not.toBe(FALLBACK_RISK_POLICY.name)
  })
})

describe('the shipped Balanced preset is unchanged by the fallback', () => {
  it('still auto-merges within its ceilings, with no class floors', () => {
    const balanced = seedRiskPolicies().find((p) => p.id === 'mp_balanced')!
    expect(balanced.autoMergeEnabled).toBe(true)
    expect(balanced.isDefault).toBe(true)
    expect(balanced.classRules).toEqual({})
    expect([balanced.maxComplexity, balanced.maxRisk, balanced.maxImpact]).toEqual([
      DEFAULT_RISK_POLICY.maxComplexity,
      DEFAULT_RISK_POLICY.maxRisk,
      DEFAULT_RISK_POLICY.maxImpact,
    ])
  })

  it('is a DIFFERENT policy from the unresolved fallback', () => {
    // The whole point of splitting the two constants: a seeded workspace lands PRs on its
    // ceilings, an unconfigured one lands none. If these ever agree, one of them is wrong.
    expect(FALLBACK_RISK_POLICY.autoMergeEnabled).not.toBe(DEFAULT_RISK_POLICY.autoMergeEnabled)
    expect(FALLBACK_RISK_POLICY.name).not.toBe(DEFAULT_RISK_POLICY.name)
  })
})
