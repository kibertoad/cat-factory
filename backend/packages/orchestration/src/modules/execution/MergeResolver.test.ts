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

const PRESET = {
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

function makeResolver(over: Partial<MergeResolverDeps> & { preset?: typeof PRESET } = {}) {
  const finalizeMerge = over.finalizeMerge ?? vi.fn().mockResolvedValue(undefined)
  const update = vi.fn().mockResolvedValue(undefined)
  const raise = vi.fn().mockResolvedValue(undefined)
  const deps: MergeResolverDeps = {
    blockRepository: {
      get: vi.fn().mockResolvedValue(BLOCK),
      update,
    } as unknown as MergeResolverDeps['blockRepository'],
    notificationService: { raise } as unknown as MergeResolverDeps['notificationService'],
    resolveMergePreset: vi.fn().mockResolvedValue(over.preset ?? PRESET),
    finalizeMerge,
  }
  return { resolver: new MergeResolver(deps), finalizeMerge, update, raise }
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
})
