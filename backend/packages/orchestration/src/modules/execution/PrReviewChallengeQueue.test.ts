import { describe, expect, it } from 'vitest'
import type {
  AgentJobHandle,
  AgentJobUpdate,
  AgentRunResult,
  ExecutionInstance,
  PipelineStep,
  PrReviewFinding,
} from '@cat-factory/kernel'
import { MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS } from '@cat-factory/contracts'
import {
  PrReviewChallengeQueue,
  type PrReviewChallengeQueueDeps,
} from './PrReviewChallengeQueue.js'
import type { StepHandlerContext } from './step-handler-registry.js'

function finding(id: string): PrReviewFinding {
  return {
    id,
    path: 'src/a.ts',
    severity: 'medium',
    category: 'correctness',
    title: `title ${id}`,
    detail: `detail ${id}`,
    challenge: { status: 'queued', question: null, justification: null },
  } as PrReviewFinding
}

/** A review step with `count` findings, every one challenged and queued in id order. */
function challengingStep(count: number): PipelineStep {
  const findings = Array.from({ length: count }, (_, i) => finding(`prf_${i}`))
  return {
    agentKind: 'pr-reviewer',
    state: 'running',
    prReview: {
      status: 'challenging',
      findings,
      selectedFindingIds: findings.map((f) => f.id),
      slices: [],
    },
    challengeJobs: findings.map((f) => ({ findingId: f.id, question: null })),
  } as unknown as PipelineStep
}

function harness(step: PipelineStep, opts: { inline?: boolean; throwFor?: string } = {}) {
  const instance = {
    id: 'exe_1',
    blockId: 'blk_1',
    currentStep: 0,
    steps: [step],
  } as unknown as ExecutionInstance
  const started: { findingId: string; epoch: number }[] = []
  const updates = new Map<string, AgentJobUpdate>()
  let parked = 0
  const deps: PrReviewChallengeQueueDeps = {
    runStateMachine: {
      persistAndEmit: async () => {},
      parkStepOnDecision: async () => {
        parked++
        return { kind: 'awaiting_decision', decisionId: 'appr_1' }
      },
    } as never,
    agentKindRegistry: { structuredOutput: () => ({ safeParse: (v: unknown) => v }) } as never,
    spend: {} as never,
    clock: { now: () => 1_000_000 } as never,
    startSideJob: async (_ctx, _kind, epoch, augment) => {
      const context = { priorOutputs: [] } as never as { priorOutputs: { output: string }[] }
      augment(context as never)
      const findingId = /title (prf_\d+)/.exec(context.priorOutputs[0]!.output)![1]!
      if (findingId === opts.throwFor) throw new Error('no capacity')
      started.push({ findingId, epoch })
      if (opts.inline) {
        return { result: { output: '', custom: { verdict: 'upheld', justification: 'ok' } } }
      }
      return { job: { jobId: `job-${findingId}`, model: 'm' } as AgentJobHandle }
    },
    pollSideJob: async (handle) => updates.get(handle.jobId) ?? { state: 'running' },
  }
  const queue = new PrReviewChallengeQueue(deps)
  const ctx = { workspaceId: 'ws_1', instance, step, block: {}, isFinalStep: true } as never
  return {
    queue,
    instance,
    started,
    ctx: ctx as StepHandlerContext,
    finish: (findingId: string, result: AgentRunResult) =>
      updates.set(`job-${findingId}`, { state: 'done', result }),
    fail: (findingId: string, error: string) =>
      updates.set(`job-${findingId}`, { state: 'failed', error }),
    parked: () => parked,
  }
}

const statusOf = (step: PipelineStep, id: string) =>
  step.prReview!.findings!.find((f) => f.id === id)!.challenge!.status

describe('PrReviewChallengeQueue', () => {
  it(`runs at most ${MAX_CONCURRENT_CHALLENGE_INVESTIGATIONS} investigators, the rest queued in order`, async () => {
    const step = challengingStep(5)
    const h = harness(step)
    const result = await h.queue.drive(h.ctx)
    expect(result).toEqual({ kind: 'awaiting_investigations', stepIndex: 0 })
    expect(h.started.map((s) => s.findingId)).toEqual(['prf_0', 'prf_1', 'prf_2'])
    expect(['prf_0', 'prf_1', 'prf_2'].map((id) => statusOf(step, id))).toEqual([
      'investigating',
      'investigating',
      'investigating',
    ])
    expect(statusOf(step, 'prf_3')).toBe('queued')
    expect(statusOf(step, 'prf_4')).toBe('queued')
  })

  it('gives every started investigator its own dispatch epoch', async () => {
    const step = challengingStep(3)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    expect(h.started.map((s) => s.epoch)).toEqual([0, 1, 2])
  })

  it('holds the park while every investigator is still running', async () => {
    const step = challengingStep(2)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    expect(await h.queue.poll('ws_1', h.instance, step)).toEqual({
      kind: 'awaiting_investigations',
      stepIndex: 0,
    })
  })

  it('applies a settled verdict and answers continue, so the handler fills the freed slot', async () => {
    const step = challengingStep(4)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    h.finish('prf_1', { output: '', custom: { verdict: 'retracted', justification: 'Not real.' } })
    expect(await h.queue.poll('ws_1', h.instance, step)).toEqual({ kind: 'continue' })
    expect(statusOf(step, 'prf_1')).toBe('retracted')
    expect(step.prReview!.selectedFindingIds).not.toContain('prf_1')
    // The next advance starts the queued one into the slot prf_1 freed.
    await h.queue.drive(h.ctx)
    expect(h.started.map((s) => s.findingId)).toEqual(['prf_0', 'prf_1', 'prf_2', 'prf_3'])
    expect(statusOf(step, 'prf_3')).toBe('investigating')
  })

  it('records a failed investigation on its finding without touching the others', async () => {
    const step = challengingStep(2)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    h.fail('prf_0', 'The investigator container crashed.')
    expect(await h.queue.poll('ws_1', h.instance, step)).toEqual({ kind: 'continue' })
    const failed = step.prReview!.findings!.find((f) => f.id === 'prf_0')!
    expect(failed.challenge).toMatchObject({
      status: 'failed',
      justification: 'The investigator container crashed.',
    })
    expect(failed.detail).toBe('detail prf_0')
    expect(statusOf(step, 'prf_1')).toBe('investigating')
  })

  it('settles a dispatch that throws as a failed challenge rather than failing the run', async () => {
    const step = challengingStep(2)
    const h = harness(step, { throwFor: 'prf_0' })
    const result = await h.queue.drive(h.ctx)
    expect(result).toEqual({ kind: 'awaiting_investigations', stepIndex: 0 })
    expect(step.prReview!.findings!.find((f) => f.id === 'prf_0')!.challenge).toMatchObject({
      status: 'failed',
      justification: 'no capacity',
    })
    expect(statusOf(step, 'prf_1')).toBe('investigating')
  })

  it('re-parks the review for the human once the queue drains', async () => {
    const step = challengingStep(1)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    h.finish('prf_0', { output: '', custom: { verdict: 'upheld', justification: 'Holds.' } })
    await h.queue.poll('ws_1', h.instance, step)
    expect(await h.queue.drive(h.ctx)).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(step.prReview!.status).toBe('awaiting_selection')
    expect(step.challengeJobs).toEqual([])
    expect(h.parked()).toBe(1)
  })

  it('settles every challenge in the same advance on an inline executor', async () => {
    const step = challengingStep(4)
    const h = harness(step, { inline: true })
    expect(await h.queue.drive(h.ctx)).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(['prf_0', 'prf_1', 'prf_2', 'prf_3'].map((id) => statusOf(step, id))).toEqual([
      'upheld',
      'upheld',
      'upheld',
      'upheld',
    ])
  })

  it('re-addresses a claimed job a replay interrupted, under the epoch it claimed', async () => {
    const step = challengingStep(1)
    // Claimed (epoch persisted) but the executor never answered before the driver died.
    step.challengeJobs = [{ findingId: 'prf_0', question: null, epoch: 7 }]
    const h = harness(step)
    await h.queue.drive(h.ctx)
    expect(h.started).toEqual([{ findingId: 'prf_0', epoch: 7 }])
    expect(step.challengeJobs[0]!.jobId).toBe('job-prf_0')
  })

  it('answers continue when a challenge was queued into a free slot while the others ran', async () => {
    const step = challengingStep(1)
    const h = harness(step)
    await h.queue.drive(h.ctx)
    step.challengeJobs!.push({ findingId: 'prf_late', question: null })
    expect(await h.queue.poll('ws_1', h.instance, step)).toEqual({ kind: 'continue' })
  })
})
