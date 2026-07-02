import { describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance } from '@cat-factory/kernel'
import { MergeResolver, type MergeResolverDeps } from './MergeResolver.js'

const block = (status: Block['status']): Block =>
  ({
    id: 'task_login',
    title: 'Login',
    level: 'task',
    status,
    pullRequest: { url: 'https://gh/pr/1', number: 1, branch: 'cat-factory/task_login' },
  }) as unknown as Block

const instance = (): ExecutionInstance =>
  ({
    id: 'exec1',
    blockId: 'task_login',
    pipelineId: 'pl1',
    pipelineName: 'Build',
    steps: [],
    currentStep: 0,
    status: 'running',
  }) as unknown as ExecutionInstance

const assessment = {
  complexity: 0.1,
  risk: 0.1,
  impact: 0.1,
  rationale: 'Small, well-tested change.',
}

function makeResolver(blockStatus: Block['status'], over: Partial<MergeResolverDeps> = {}) {
  const update = vi.fn(async () => {})
  const raise = vi.fn(async () => ({}) as never)
  const finalizeMerge = vi.fn(async () => {})
  const deps = {
    blockRepository: { get: async () => block(blockStatus), update },
    notificationService: { raise },
    resolveMergePreset: async () => ({
      maxComplexity: 0.5,
      maxRisk: 0.5,
      maxImpact: 0.5,
      autoMergeEnabled: true,
    }),
    finalizeMerge,
    ...over,
  } as unknown as MergeResolverDeps
  return { resolver: new MergeResolver(deps), update, raise, finalizeMerge }
}

describe('MergeResolver replay safety', () => {
  it('merges a within-threshold PR and leaves the block alone (finalizeMerge owns the flip)', async () => {
    const { resolver, update, raise, finalizeMerge } = makeResolver('in_progress')
    await resolver.resolveMergerStep('ws1', instance(), assessment)
    expect(finalizeMerge).toHaveBeenCalledTimes(1)
    expect(update).not.toHaveBeenCalled()
    expect(raise).not.toHaveBeenCalled()
  })

  it('is a complete no-op on an already-done block (durable-driver replay)', async () => {
    // A crash between the real merge and the instance persist replays the merger step.
    // The block is already `done` (= merged): the resolver must not re-merge, must not
    // downgrade it to `pr_ready`, and must not raise a spurious merge_review.
    const { resolver, update, raise, finalizeMerge } = makeResolver('done')
    await resolver.resolveMergerStep('ws1', instance(), assessment)
    expect(finalizeMerge).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(raise).not.toHaveBeenCalled()
  })

  it('still routes a genuinely failed merge on a live block to human review', async () => {
    const { resolver, update, raise } = makeResolver('in_progress', {
      finalizeMerge: vi.fn(async () => {
        throw new Error('branch protection')
      }),
    })
    await resolver.resolveMergerStep('ws1', instance(), assessment)
    expect(update).toHaveBeenCalledWith('ws1', 'task_login', { status: 'pr_ready', progress: 1 })
    expect(raise).toHaveBeenCalledTimes(1)
  })
})
