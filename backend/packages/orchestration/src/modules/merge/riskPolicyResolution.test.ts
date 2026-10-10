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
    companionMaxReworks: 3,
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
    autonomy: 'attended',
    minAutoAnswerConfidence: 0.8,
    isDefault: false,
    isUnattendedDefault: false,
    createdAt: 0,
    ...over,
  }
}

function fakeRepo(rows: RiskPolicy[]): RiskPolicyRepository {
  return {
    get: async (_ws, id) => rows.find((r) => r.id === id) ?? null,
    list: async () => rows,
    getDefault: async (_ws, scope) =>
      rows.find((r) => (scope === 'unattended' ? r.isUnattendedDefault : r.isDefault)) ?? null,
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
      scope: 'interactive',
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
      scope: 'interactive',
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
      scope: 'interactive',
    })
    expect(resolved.autoMergeEnabled).toBe(false)
    expect(resolved.id).toBeUndefined()
  })

  it('reports ceilings no assessment can pass, so a banner never blames a threshold', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: null,
      scope: 'interactive',
    })
    expect([resolved.maxComplexity, resolved.maxRisk, resolved.maxImpact]).toEqual([0, 0, 0])
  })

  it('keeps the BUDGET knobs, which are not postures', async () => {
    const resolved = await resolveRiskPolicy({
      repository: undefined,
      workspaceId: WS,
      riskPolicyId: null,
      scope: 'interactive',
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
      scope: 'interactive',
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
      scope: 'interactive',
    })
    expect(resolved.id).toBe('mp_pinned')
  })

  it('uses the workspace default when the task pins nothing', async () => {
    const dflt = policy({ id: 'mp_default', isDefault: true })
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([dflt]),
      workspaceId: WS,
      riskPolicyId: null,
      scope: 'interactive',
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
      scope: 'interactive',
    })
    expect(resolved.id).toBe('mp_default')
    expect(resolved.name).not.toBe(FALLBACK_RISK_POLICY.name)
  })
})

describe('resolveRiskPolicy: which DEFAULT a run falls back to', () => {
  const inApp = policy({ id: 'mp_in_app', name: 'In app', isDefault: true })
  const unwatched = policy({
    id: 'mp_unwatched',
    name: 'Unwatched',
    isUnattendedDefault: true,
    autonomy: 'unattended',
  })

  it('resolves a DIFFERENT row per scope for a task that pinned nothing', async () => {
    // The whole point of the second flag: one board, one unpinned task, two answers depending on
    // whether anybody is watching the run. Asserted as a pair rather than one scope at a time,
    // because a resolution that ignored the argument would pass either half alone.
    const repo = fakeRepo([inApp, unwatched])
    const base = { repository: repo, workspaceId: WS, riskPolicyId: null }
    expect((await resolveRiskPolicy({ ...base, scope: 'interactive' })).id).toBe('mp_in_app')
    expect((await resolveRiskPolicy({ ...base, scope: 'unattended' })).id).toBe('mp_unwatched')
  })

  it('lets a task PIN past both defaults, whichever scope asked', async () => {
    // The pin is the task's own statement and outranks either default. Both scopes are asserted
    // because the scope must only ever decide the FALLBACK, and a resolution that consulted it
    // first would silently override an operator's per-task choice on every API-started run.
    const pinned = policy({ id: 'mp_pinned', name: 'Pinned' })
    const repo = fakeRepo([inApp, unwatched, pinned])
    for (const scope of ['interactive', 'unattended'] as const) {
      const resolved = await resolveRiskPolicy({
        repository: repo,
        workspaceId: WS,
        riskPolicyId: 'mp_pinned',
        scope,
      })
      expect(resolved.id, scope).toBe('mp_pinned')
    }
  })

  it('REFUSES rather than borrowing the other scope when a workspace names only one default', async () => {
    // A library seeded before the unattended scope existed has an in-app default and no
    // unattended one. Falling back to the in-app row would look like a kindness and would be a
    // lie: it would hand every unwatched run a policy nobody chose for it. `FALLBACK_RISK_POLICY`
    // auto-merges nothing, which is the honest reading of "no policy stated for this scope" and
    // the same one an unwired repository gets.
    const resolved = await resolveRiskPolicy({
      repository: fakeRepo([inApp]),
      workspaceId: WS,
      riskPolicyId: null,
      scope: 'unattended',
    })
    expect(resolved.id).toBeUndefined()
    expect(resolved.autoMergeEnabled).toBe(false)
    // And it does NOT inherit the licence to answer its own caps either.
    expect(resolved.autonomy).toBe('attended')
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
