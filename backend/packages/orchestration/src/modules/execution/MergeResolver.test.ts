import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, MergeAssessment } from '@cat-factory/kernel'
import { MergeResolver, type MergeResolverDeps } from './MergeResolver.js'

// The engine's merge policy in one place: given a merger assessment + the task's resolved
// preset, decide whether to merge for real or route to human review, and record a precise,
// SPA-renderable `MergeDecision` explaining WHY. This locks every classification branch so a
// future edit can't silently mis-label (or, worse, auto-merge) a verdict.

const BLOCK: Block = {
  id: 'task_login',
  title: 'Login',
  pullRequest: { url: 'https://pr' },
} as Block
const INSTANCE: ExecutionInstance = {
  id: 'exec_1',
  blockId: 'task_login',
  pipelineName: 'Build',
} as ExecutionInstance

// A real workspace preset, so it carries an id: the resolver reads the id's ABSENCE as "no
// preset resolved, this is the built-in fallback" and names that refusal differently. An id-less
// fixture would put every case below on the unconfigured path.
const PRESET = {
  id: 'mp_balanced',
  name: 'Balanced',
  maxComplexity: 0.5,
  maxRisk: 0.4,
  maxImpact: 0.5,
  autoMergeEnabled: true,
}

const assessment = (over: Partial<MergeAssessment> = {}): MergeAssessment => ({
  complexity: 0.1,
  risk: 0.1,
  impact: 0.1,
  rationale: 'Examined the diff; small, low-risk change.',
  ...over,
})

function makeResolver(
  over: Partial<MergeResolverDeps> & {
    preset?: Record<string, unknown>
    /** The class the (stubbed) track-record service reports; omit for no service at all. */
    changeClass?: string
  } = {},
) {
  const finalizeMerge = over.finalizeMerge ?? vi.fn().mockResolvedValue({ kind: 'merged' })
  const update = vi.fn().mockResolvedValue(undefined)
  const raise = vi.fn().mockResolvedValue(undefined)
  const recordDecision = vi.fn().mockResolvedValue({ id: 'mtr_exec_1' })
  const deps: MergeResolverDeps = {
    blockRepository: {
      get: vi.fn().mockResolvedValue(BLOCK),
      update,
    } as unknown as MergeResolverDeps['blockRepository'],
    notificationService: { raise } as unknown as MergeResolverDeps['notificationService'],
    resolveRiskPolicy: vi.fn().mockResolvedValue(over.preset ?? PRESET),
    finalizeMerge,
    // Only wired when the test supplies a class — otherwise the resolver runs with NO track-record
    // service at all, which is the pass-through shape every pre-existing case below asserts.
    ...(over.changeClass
      ? {
          mergeTrackRecord: {
            classify: vi.fn().mockResolvedValue({ changeClass: over.changeClass, fileCount: 2 }),
            recordDecision,
          } as unknown as MergeResolverDeps['mergeTrackRecord'],
        }
      : {}),
  }
  return { resolver: new MergeResolver(deps), finalizeMerge, update, raise, recordDecision }
}

describe('MergeResolver.resolveMergerStep', () => {
  it('auto-merges a credible within-threshold assessment', async () => {
    const { resolver, finalizeMerge, raise } = makeResolver()
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'within_thresholds' })
    expect(decision?.exceededAxes).toEqual([])
    expect(decision?.thresholds.presetName).toBe('Balanced')
    expect(finalizeMerge).toHaveBeenCalledOnce()
    expect(raise).not.toHaveBeenCalled()
  })

  it('routes to review and lists the exceeded axes when a score is over its ceiling', async () => {
    const { resolver, finalizeMerge, update, raise } = makeResolver()
    const decision = await resolver.resolveMergerStep(
      'ws',
      INSTANCE,
      assessment({ risk: 0.9, impact: 0.8 }),
    )
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'exceeded_thresholds' })
    expect(decision?.exceededAxes).toEqual(['risk', 'impact'])
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith('ws', 'task_login', { status: 'pr_ready', progress: 1 })
    expect(raise).toHaveBeenCalledOnce()
  })

  it('routes every PR to review when the preset disables auto-merge', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, name: 'Manual', autoMergeEnabled: false },
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'auto_merge_disabled' })
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('names an UNCONFIGURED deployment apart from a preset that asks for review', async () => {
    // Same rung of the ladder, opposite remedies. The built-in fallback is the one policy with no
    // id (no workspace has a row for it), and reporting it as `auto_merge_disabled` would send the
    // reader hunting for a preset to edit that their deployment never had.
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        name: 'No merge policy configured',
        maxComplexity: 0,
        maxRisk: 0,
        maxImpact: 0,
        autoMergeEnabled: false,
      },
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toMatchObject({
      outcome: 'awaiting_review',
      reason: 'no_policy_configured',
    })
    expect(decision?.thresholds.presetName).toBe('No merge policy configured')
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('keeps the unconfigured refusal below a dry run and a submission bar', async () => {
    // The fallback does not climb the ladder: it refuses on the master-switch rung, so a run that
    // was ALSO sandboxed still reports `dry_run` — the reason a reader has to act on first.
    const { resolver } = makeResolver({
      preset: {
        name: 'No merge policy configured',
        maxComplexity: 0,
        maxRisk: 0,
        maxImpact: 0,
        autoMergeEnabled: false,
      },
    })
    const decision = await resolver.resolveMergerStep(
      'ws',
      { ...INSTANCE, mode: 'dry_run' },
      assessment(),
    )
    expect(decision?.reason).toBe('dry_run')
  })

  it('routes to review as `no_rationale` when the scores lack an explanation', async () => {
    const { resolver, finalizeMerge } = makeResolver()
    const decision = await resolver.resolveMergerStep(
      'ws',
      INSTANCE,
      assessment({ rationale: '  ' }),
    )
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'no_rationale' })
    // The scored assessment is still surfaced so the UI can show the bars.
    expect(decision?.assessment).toBeDefined()
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('routes to review as `no_assessment` when the payload is unparseable', async () => {
    const { resolver } = makeResolver()
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, { not: 'an assessment' })
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'no_assessment' })
    expect(decision?.assessment).toBeUndefined()
    expect(decision?.exceededAxes).toEqual([])
  })

  it('falls through to review as `merge_failed` when the real merge throws', async () => {
    const { resolver, raise } = makeResolver({
      finalizeMerge: vi.fn().mockRejectedValue(new Error('branch protection')),
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'merge_failed' })
    // A within-threshold assessment has no exceeded axes even when the merge fails.
    expect(decision?.exceededAxes).toEqual([])
    expect(raise).toHaveBeenCalledOnce()
  })

  it('records `merge_partial` (no second review card) when a multi-repo merge lands only some PRs', async () => {
    const { resolver, raise } = makeResolver({
      // finalizeMerge already blocked the block + raised the enumerated partial-merge card.
      finalizeMerge: vi
        .fn()
        .mockResolvedValue({ kind: 'partial', merged: ['own service'], unmerged: ['org/email'] }),
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'merge_partial' })
    expect(decision?.exceededAxes).toEqual([])
    // The resolver must NOT raise its own review notification — finalizeMerge owns the card.
    expect(raise).not.toHaveBeenCalled()
  })

  it('returns null (nothing to record) when the block cannot be loaded', async () => {
    const { resolver } = makeResolver()
    const deps = (resolver as unknown as { deps: MergeResolverDeps }).deps
    ;(deps.blockRepository.get as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null)
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toBeNull()
  })
})

describe('MergeResolver replay safety', () => {
  it('is a complete no-op on an already-done block (durable-driver replay)', async () => {
    // A crash between the real merge and the instance persist replays the merger step.
    // The block is already `done` (= merged): the resolver must not re-merge, must not
    // downgrade it to `pr_ready`, and must not raise a spurious merge_review.
    const { resolver, finalizeMerge, update, raise } = makeResolver()
    const deps = (resolver as unknown as { deps: MergeResolverDeps }).deps
    ;(deps.blockRepository.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...BLOCK,
      status: 'done',
    } as Block)
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(decision).toBeNull()
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(raise).not.toHaveBeenCalled()
  })

  // ---- per-class auto-merge rules -----------------------------------------
  // Precedence, most-significant first: `autoMergeEnabled: false` > the class rule > the
  // credibility + threshold comparison. Each rung is pinned so a future edit can't reorder them.

  it('auto-merges an over-threshold assessment when the class rule is `always`', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, classRules: { dependency: 'always' } },
      changeClass: 'dependency',
    })
    const decision = await resolver.resolveMergerStep(
      'ws',
      INSTANCE,
      assessment({ complexity: 0.99, risk: 0.99, impact: 0.99 }),
    )
    expect(finalizeMerge).toHaveBeenCalledOnce()
    expect(decision?.outcome).toBe('auto_merged')
    // The reason names the RULE, so the banner never implies the scores were within range.
    expect(decision?.reason).toBe('class_auto_merge')
    expect(decision?.thresholds.classRule).toBe('always')
    expect(decision?.changeClass).toBe('dependency')
  })

  it('auto-merges on an `always` class rule even with NO credible assessment', async () => {
    // An explicit operator policy keyed on a DETERMINISTIC backend classification outranks the
    // agent's self-report — including the empty-rationale backstop, which exists to distrust the
    // agent, not the file list. (A pipeline may legitimately have no merger step at all.)
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, classRules: { docs: 'always' } },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, { not: 'an assessment' })
    expect(finalizeMerge).toHaveBeenCalledOnce()
    expect(decision?.outcome).toBe('auto_merged')
    expect(decision?.reason).toBe('class_auto_merge')
  })

  it('forces review on a within-threshold assessment when the class rule is `never`', async () => {
    const { resolver, finalizeMerge, raise, update } = makeResolver({
      preset: { ...PRESET, classRules: { schema: 'never' } },
      changeClass: 'schema',
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(raise).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith('ws', 'task_login', { status: 'pr_ready', progress: 1 })
    expect(decision?.outcome).toBe('awaiting_review')
    expect(decision?.reason).toBe('class_requires_review')
    expect(decision?.thresholds.classRule).toBe('never')
  })

  it('lets `autoMergeEnabled: false` beat an `always` class rule', async () => {
    // The master switch. A "manual review only" preset must stay manual, or its whole guarantee
    // evaporates the moment somebody widens one class.
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, autoMergeEnabled: false, classRules: { docs: 'always' } },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(decision?.reason).toBe('auto_merge_disabled')
  })

  it('ignores a rule for a DIFFERENT class than the run resolved', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, classRules: { docs: 'never' } },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(finalizeMerge).toHaveBeenCalledOnce()
    expect(decision?.reason).toBe('within_thresholds')
    // No rule applied ⇒ the field is omitted rather than reported as `thresholds`.
    expect(decision?.thresholds.classRule).toBeUndefined()
  })

  it('falls back to the thresholds when the class is `unknown`, whatever rules exist', async () => {
    // The load-bearing invariant: a diff we could not read must not change policy. Even a preset
    // that widened every class leaves an unclassifiable PR on the score comparison.
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { docs: 'always', source: 'always', schema: 'always' },
      },
      changeClass: 'unknown',
    })
    const decision = await resolver.resolveMergerStep(
      'ws',
      INSTANCE,
      assessment({ complexity: 0.99 }),
    )
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(decision?.reason).toBe('exceeded_thresholds')
    // `unknown` is not surfaced as a class on the decision — the field is simply absent.
    expect(decision?.changeClass).toBeUndefined()
  })

  it('records the decision on the track record, with the classification threaded through', async () => {
    // The classification is computed ONCE (before the policy decision, which needs it) and passed
    // into the record write, so the merge path never pays for a second VCS call.
    const { resolver, recordDecision } = makeResolver({ changeClass: 'source' })
    await resolver.resolveMergerStep('ws', INSTANCE, assessment())
    expect(recordDecision).toHaveBeenCalledExactlyOnceWith('ws', {
      block: BLOCK,
      executionId: 'exec_1',
      decision: 'auto_merged',
      assessment: assessment(),
      // The resolved preset's row id, so a decision can be read back in the policy context it was
      // made under. Null only where no preset resolved at all (the built-in fallback).
      riskPolicyId: 'mp_balanced',
      riskPolicyName: 'Balanced',
      classification: { changeClass: 'source', fileCount: 2 },
    })
  })

  it('raises the review card BEFORE flipping the block to `pr_ready`', async () => {
    const { resolver, raise, update } = makeResolver()
    await resolver.resolveMergerStep('ws', INSTANCE, assessment({ complexity: 0.99 }))
    expect(raise).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledOnce()
    expect(raise.mock.invocationCallOrder[0]!).toBeLessThan(update.mock.invocationCallOrder[0]!)
  })

  it('leaves the block alone when the review card cannot be raised', async () => {
    // The card is the ONLY actionable prompt this outcome produces, so a raise failure must not
    // leave a `pr_ready` block that looks finished-and-waiting with an empty inbox — the throw
    // fails the run instead, which the board surfaces (and which is retryable).
    const { resolver, raise, update } = makeResolver()
    raise.mockRejectedValue(new Error('notification store down'))
    await expect(
      resolver.resolveMergerStep('ws', INSTANCE, assessment({ complexity: 0.99 })),
    ).rejects.toThrow('notification store down')
    expect(update).not.toHaveBeenCalled()
  })

  it('records a `pending_review` decision and puts the record on the review card', async () => {
    const { resolver, recordDecision, raise } = makeResolver({ changeClass: 'source' })
    await resolver.resolveMergerStep('ws', INSTANCE, assessment({ complexity: 0.99 }))
    expect(recordDecision).toHaveBeenCalledExactlyOnceWith(
      'ws',
      expect.objectContaining({ decision: 'pending_review' }),
    )
    // The card carries the class + record id so the human can confirm-and-tag in one tap.
    expect(raise).toHaveBeenCalledWith(
      'ws',
      expect.objectContaining({
        payload: expect.objectContaining({
          changeClass: 'source',
          mergeTrackRecordId: 'mtr_exec_1',
        }),
      }),
    )
  })
})

// ---------------------------------------------------------------------------
// Role-scoped class rules + the sandboxed run mode. Both narrow the SAME decision the cases
// above make, so what these lock is the precedence: a role may only push toward review, and a
// dry run outranks every reason the policy could otherwise report.
// ---------------------------------------------------------------------------

/** The run, as started by `role` and (optionally) sandboxed. */
const runBy = (role?: string, mode?: string): ExecutionInstance =>
  ({ ...INSTANCE, initiatedByRole: role, mode }) as unknown as ExecutionInstance

describe('MergeResolver: role-scoped class rules', () => {
  it('auto-merges when the role leaves the widened class alone', () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { docs: 'always' },
        classRulesByRole: { member: { source: 'never' } },
      },
      changeClass: 'docs',
    })
    return resolver.resolveMergerStep('ws', runBy('member'), assessment()).then((decision) => {
      expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'class_auto_merge' })
      expect(decision?.thresholds.roleRule).toBeUndefined()
      expect(decision?.thresholds.initiatorRole).toBe('member')
      expect(finalizeMerge).toHaveBeenCalledOnce()
    })
  })

  it('routes to review as `role_requires_review` when the initiator’s role forbids the class', async () => {
    const { resolver, finalizeMerge, raise } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { source: 'always' },
        classRulesByRole: { member: { source: 'never' } },
      },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'role_requires_review' })
    // Distinguishable from a class-level refusal: the banner has to be able to say a teammate on
    // a higher tier can merge this as it stands.
    expect(decision?.thresholds.roleRule).toBe('never')
    expect(decision?.thresholds.classRule).toBe('always')
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(raise).toHaveBeenCalledOnce()
  })

  it('keeps `class_requires_review` when the BASE rule is what forbids the class', async () => {
    const { resolver } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { schema: 'never' },
        classRulesByRole: { member: { schema: 'never' } },
      },
      changeClass: 'schema',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    // The role restated the base rule rather than narrowing it, so blaming the role would send
    // someone hunting for a teammate who could merge it — nobody can.
    expect(decision).toMatchObject({ reason: 'class_requires_review' })
    expect(decision?.thresholds.roleRule).toBeUndefined()
  })

  it('NEVER lets a role entry widen what the preset withholds', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { source: 'never' },
        classRulesByRole: { member: { source: 'always' } },
      },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'class_requires_review' })
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('leaves an UNATTRIBUTED run on the base rules', async () => {
    // A schedule fire has no role to scope by, so it must behave exactly as it did before role
    // scoping existed rather than being guessed onto a tier.
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { docs: 'always' },
        classRulesByRole: { member: { docs: 'never' }, admin: { docs: 'never' } },
      },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy(undefined), assessment())
    expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'class_auto_merge' })
    expect(decision?.thresholds.initiatorRole).toBeUndefined()
    expect(finalizeMerge).toHaveBeenCalledOnce()
  })
})

describe('MergeResolver: dry run', () => {
  it('never merges a dry run, however good the assessment', async () => {
    const { resolver, finalizeMerge, update, raise } = makeResolver()
    const decision = await resolver.resolveMergerStep(
      'ws',
      runBy('member', 'dry_run'),
      assessment(),
    )
    expect(decision).toMatchObject({ outcome: 'awaiting_review', reason: 'dry_run' })
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith('ws', 'task_login', { status: 'pr_ready', progress: 1 })
    expect(raise).toHaveBeenCalledOnce()
  })

  it('outranks a class rule that would otherwise auto-merge', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, classRules: { docs: 'always' } },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep(
      'ws',
      runBy('member', 'dry_run'),
      assessment(),
    )
    expect(decision).toMatchObject({ reason: 'dry_run' })
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('reports `dry_run` rather than a score/policy reason that had no part in the outcome', async () => {
    // A sandboxed run's scores were never consulted, so reporting `exceeded_thresholds` (or
    // `auto_merge_disabled`) would send someone to edit a ceiling that did not decide this.
    const overThreshold = await makeResolver()
      .resolver.resolveMergerStep('ws', runBy('member', 'dry_run'), assessment({ risk: 0.99 }))
      .then((d) => d?.reason)
    expect(overThreshold).toBe('dry_run')
    const autoMergeOff = await makeResolver({
      preset: { ...PRESET, autoMergeEnabled: false },
    })
      .resolver.resolveMergerStep('ws', runBy('member', 'dry_run'), assessment())
      .then((d) => d?.reason)
    expect(autoMergeOff).toBe('dry_run')
  })

  it('does not blame the thresholds in the review card it raises', async () => {
    const { resolver, raise } = makeResolver()
    await resolver.resolveMergerStep('ws', runBy('member', 'dry_run'), assessment())
    const body = raise.mock.calls[0]?.[1]?.body as string
    expect(body).toContain('dry run')
    expect(body).not.toContain('outside the task')
  })

  it('leaves a run with NO recorded mode merging exactly as before', async () => {
    // Every run that predates the mode reads as live; a sandbox must never be inferred.
    const { resolver, finalizeMerge } = makeResolver()
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'within_thresholds' })
    expect(finalizeMerge).toHaveBeenCalledOnce()
  })
})

describe('MergeResolver: per-role submission allowlist', () => {
  it('lands a class the initiator’s role allowlists', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: ['docs', 'dependency'] } },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'within_thresholds' })
    expect(finalizeMerge).toHaveBeenCalledOnce()
    // Recorded even though the allowlist PERMITTED this one: the scope is what explains why the
    // same role's next PR on `source` will not land.
    expect(decision?.thresholds.submissionClasses).toEqual(['docs', 'dependency'])
  })

  it('refuses a class outside the allowlist, even on scores that would have merged', async () => {
    const { resolver, finalizeMerge, raise } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: ['docs'] } },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({
      outcome: 'awaiting_review',
      reason: 'submission_not_allowed',
    })
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(raise).toHaveBeenCalledOnce()
  })

  // The whole point of the setting: it is a bar on LANDING, where a class rule only decides how
  // much review landing takes. A class rule cannot express this, because `always` under
  // `classRules` is exactly the case that has to keep being refused.
  it('outranks an `always` class rule and the master switch alike', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: {
        ...PRESET,
        classRules: { source: 'always' },
        submissionClassesByRole: { member: ['docs'] },
      },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ reason: 'submission_not_allowed' })
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  it('reports the sandbox first when a run is BOTH sandboxed and outside the allowlist', async () => {
    // Both refuse, but only one of them is fixable by re-running: telling someone their role may
    // not land this class, when a live run of the same task would have landed it, is a lie.
    const { resolver } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: ['docs'] } },
      changeClass: 'source',
    })
    const decision = await resolver.resolveMergerStep(
      'ws',
      runBy('member', 'dry_run'),
      assessment(),
    )
    expect(decision).toMatchObject({ reason: 'dry_run' })
  })

  it('names the policy, not the thresholds, in the review card it raises', async () => {
    const { resolver, raise } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: ['docs'] } },
      changeClass: 'source',
    })
    await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    const body = raise.mock.calls[0]?.[1]?.body as string
    expect(body).toContain('source')
    expect(body).not.toContain('outside the task')
  })

  it('leaves an unscoped role, and an unattributed run, landing exactly as before', async () => {
    // Silence is not an empty allowlist: authoring one role's scope must not bar every other.
    const preset = { ...PRESET, submissionClassesByRole: { viewer: ['docs'] } }
    const scoped = makeResolver({ preset, changeClass: 'source' })
    const admin = await scoped.resolver.resolveMergerStep('ws', runBy('admin'), assessment())
    expect(admin).toMatchObject({ outcome: 'auto_merged' })
    expect(admin?.thresholds.submissionClasses).toBeUndefined()

    const anonymous = makeResolver({ preset, changeClass: 'source' })
    const unattributed = await anonymous.resolver.resolveMergerStep(
      'ws',
      runBy(undefined),
      assessment(),
    )
    expect(unattributed).toMatchObject({ outcome: 'auto_merged' })
  })

  it('refuses every class for a role scoped to an EMPTY allowlist', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: [] } },
      changeClass: 'docs',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ reason: 'submission_not_allowed' })
    expect(decision?.thresholds.submissionClasses).toEqual([])
    expect(finalizeMerge).not.toHaveBeenCalled()
  })

  // The opposite disposition from the allowlist itself, and the one that keeps a VCS outage from
  // changing policy: a diff nobody could read is not evidence that the change is out of scope.
  it('lands an `unknown` classification whatever the allowlist says', async () => {
    const { resolver, finalizeMerge } = makeResolver({
      preset: { ...PRESET, submissionClassesByRole: { member: [] } },
      changeClass: 'unknown',
    })
    const decision = await resolver.resolveMergerStep('ws', runBy('member'), assessment())
    expect(decision).toMatchObject({ outcome: 'auto_merged', reason: 'within_thresholds' })
    expect(finalizeMerge).toHaveBeenCalledOnce()
  })
})
