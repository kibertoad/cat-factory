import { describe, it, expect, beforeEach } from 'vitest'
import type { BootstrapJob } from '~/types/domain'
import { useAgentRunsStore } from '~/stores/agentRuns'
import { useBootstrapRunSteps } from '~/composables/useBootstrapRunSteps'

// What this composable owns beyond the shared derivation (tested in `@cat-factory/contracts`):
// the SPA-only question of whether a run has more than one step, which is what decides whether
// the board renders a step list at all and whether the retry control offers to RESUME.

const MONOREPO: BootstrapJob['monorepo'] = {
  repoGithubId: 7,
  directory: 'services/payments',
  repoOwner: 'acme',
  repoName: 'platform',
  branch: null,
}

function job(id: string, over: Partial<BootstrapJob> = {}): BootstrapJob {
  return {
    id,
    workspaceId: 'ws_test',
    referenceArchitectureId: null,
    referenceArchitectureName: null,
    repoName: id,
    repoOwner: null,
    repoUrl: null,
    instructions: '',
    status: 'running',
    blockId: `blk_${id}`,
    subtasks: null,
    error: null,
    failure: null,
    monorepo: null,
    phase: null,
    adoptionPlan: null,
    adoptionReview: null,
    prUrl: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

/** A recorded plan; only its own status is read by the rule. */
function plan(status: 'ready' | 'unavailable'): BootstrapJob['adoptionPlan'] {
  return { status } as unknown as BootstrapJob['adoptionPlan']
}

describe('useBootstrapRunSteps', () => {
  let store: ReturnType<typeof useAgentRunsStore>
  beforeEach(() => {
    store = useAgentRunsStore()
  })

  it('offers nothing for a new-repo run, which has one move and so nothing to resume', () => {
    store.upsertBootstrap(job('b1', { status: 'failed' }))
    const { multiStep, resumeStep } = useBootstrapRunSteps('b1')
    expect(multiStep.value).toBe(false)
    // Null rather than 'scaffold': there is progress to keep on a monorepo run and none here,
    // so the card must keep saying "retry" instead of promising a resume it cannot make.
    expect(resumeStep.value).toBeNull()
  })

  it('marks the survey done and the review as the step a broken monorepo run is holding', () => {
    store.upsertBootstrap(
      job('b2', {
        monorepo: MONOREPO,
        phase: 'survey',
        status: 'failed',
        failure: { kind: 'agent' } as unknown as BootstrapJob['failure'],
        adoptionPlan: plan('ready'),
      }),
    )
    const { steps, multiStep, resumeStep } = useBootstrapRunSteps('b2')
    expect(multiStep.value).toBe(true)
    expect(steps.value).toEqual([
      { id: 'survey', state: 'done' },
      { id: 'review', state: 'failed' },
      { id: 'apply', state: 'pending' },
    ])
    expect(resumeStep.value).toBe('review')
  })

  it('renders a run the reviewer STOPPED as stopped, not as a broken review step', () => {
    // A stop is stored as a `failed` status with a `cancelled` kind, and this is the shape the
    // card actually renders: stopping a parked run must not report the reviewer's own decision
    // step back to them as a fault. The resume it offers is unchanged.
    store.upsertBootstrap(
      job('b2s', {
        monorepo: MONOREPO,
        phase: 'survey',
        status: 'failed',
        failure: { kind: 'cancelled' } as unknown as BootstrapJob['failure'],
        adoptionPlan: plan('ready'),
      }),
    )
    const { steps, resumeStep } = useBootstrapRunSteps('b2s')
    expect(steps.value.map((step) => step.state)).toEqual(['done', 'stopped', 'pending'])
    expect(resumeStep.value).toBe('review')
  })

  it('follows the run as live events advance it, rather than pinning the first read', () => {
    // The card is open while the run moves: the review is settled and the apply dispatches, and
    // the step list has to follow the store rather than the value it was mounted with.
    store.upsertBootstrap(job('b3', { monorepo: MONOREPO, phase: 'survey', updatedAt: 1 }))
    const { steps, resumeStep } = useBootstrapRunSteps('b3')
    expect(steps.value.map((s) => s.state)).toEqual(['running', 'pending', 'pending'])
    store.upsertBootstrap(
      job('b3', {
        monorepo: MONOREPO,
        phase: 'apply',
        adoptionPlan: plan('ready'),
        adoptionReview: { choices: [] } as unknown as BootstrapJob['adoptionReview'],
        updatedAt: 2,
      }),
    )
    expect(steps.value.map((s) => s.state)).toEqual(['done', 'done', 'running'])
    expect(resumeStep.value).toBe('apply')
  })

  it('answers empty for a run the store does not hold', () => {
    const { steps, multiStep, resumeStep } = useBootstrapRunSteps('nope')
    expect(steps.value).toEqual([])
    expect(multiStep.value).toBe(false)
    expect(resumeStep.value).toBeNull()
  })
})
