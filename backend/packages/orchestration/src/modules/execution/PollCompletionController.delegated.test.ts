import { describe, expect, it } from 'vitest'
import type { AgentJobUpdate, Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import {
  PollCompletionController,
  type PollCompletionControllerDeps,
} from './PollCompletionController.js'
import { MAX_DELEGATED_RETRIES } from './job.logic.js'

// What the engine does with an EXTERNAL executor's failure, which is two different things
// depending on what that executor said about it.
//
// The executor's `retryable` used to be a flag nothing read: the port documented it, the shipped
// GitHub Actions helper mapped `cancelled` / `timed_out` / `stale` onto it, and both durable
// drivers funnelled every `job_failed` straight into `failRun`. So a forty-minute run cancelled by
// a runner-pool restart hard-failed exactly like a genuine test failure, and the mapping was dead
// code. These pin that the two dispositions now diverge, and that the budget is finite.

function delegatedStep(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'acme:impl',
    jobId: 'exec-1-acme:impl',
    delegated: {
      executor: 'acme:executor',
      status: 'running',
      correlationKey: 'exec-1-acme:impl',
      poll: { intervalMs: 1_000, maxDurationMs: 60_000 },
      externalId: 'run-99',
      attempts: [{ startedAt: 1 }],
    },
    ...over,
  } as unknown as PipelineStep
}

function instance(step: PipelineStep): ExecutionInstance {
  return { id: 'exec-1', blockId: 'blk-1', currentStep: 0, steps: [step] } as ExecutionInstance
}

function failure(
  disposition: 'terminal' | 'retryable',
): Extract<AgentJobUpdate, { state: 'failed' }> {
  return {
    state: 'failed',
    error: 'The workflow run finished as "cancelled".',
    delegated: { url: 'https://ci.acme/99', disposition },
  } as unknown as Extract<AgentJobUpdate, { state: 'failed' }>
}

function controller() {
  const calls = { persists: 0, containerErrored: 0 }
  const deps = {
    blockRepository: { get: async () => ({ id: 'blk-1' }) as Block },
    clock: { now: () => 1_000 },
    runStateMachine: {
      casPersist: async () => undefined,
      persistAndEmit: async () => {
        calls.persists += 1
      },
    },
    prReviewController: {},
    recordBackendDiagnostics: () => {},
    recoverContainerEviction: async () => null,
    markDispatchErrored: async () => {
      calls.containerErrored += 1
    },
  } as unknown as PollCompletionControllerDeps
  return { controller: new PollCompletionController(deps), calls }
}

describe('PollCompletionController: a delegated failure', () => {
  it('re-dispatches a failure the executor called survivable', async () => {
    const s = delegatedStep()
    const { controller: c, calls } = controller()
    const result = await c.handleFailedPoll('ws-1', instance(s), s, failure('retryable'))
    expect(result).toEqual({ kind: 'continue' })
    // The handle goes, which is what makes the next advance DISPATCH rather than poll; the
    // dispatch epoch has moved, so the executor is asked to start a new run rather than
    // recognise the one that just failed.
    expect(s.jobId).toBeUndefined()
    expect(s.delegatedRetries).toBe(1)
    expect(calls.persists).toBe(1)
  })

  it('settles the failed attempt onto the record before dropping the handle', async () => {
    // The record is the platform's only account of work that happened elsewhere, and the next
    // claim APPENDS to its log. Dropped, a re-driven step reports its first attempt as if it
    // never happened.
    const s = delegatedStep()
    const { controller: c } = controller()
    await c.handleFailedPoll('ws-1', instance(s), s, failure('retryable'))
    expect(s.delegated?.status).toBe('failed')
    expect(s.delegated?.attempts.at(-1)).toMatchObject({
      outcome: 'The workflow run finished as "cancelled".',
      url: 'https://ci.acme/99',
    })
  })

  it('fails the run once the re-drive budget is spent, under the delegated kind', async () => {
    const s = delegatedStep({ delegatedRetries: MAX_DELEGATED_RETRIES } as Partial<PipelineStep>)
    const { controller: c } = controller()
    const result = await c.handleFailedPoll('ws-1', instance(s), s, failure('retryable'))
    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'delegated_failed' })
    // Not `harness_shutdown`: a delegated step never had a harness, and reporting one sends an
    // operator to look at a container that was never started.
    expect(result).not.toMatchObject({ failureKind: 'harness_shutdown' })
  })

  it('spends nothing on a verdict the executor called final', async () => {
    const s = delegatedStep()
    const { controller: c } = controller()
    const result = await c.handleFailedPoll('ws-1', instance(s), s, failure('terminal'))
    expect(result).toMatchObject({ kind: 'job_failed', failureKind: 'delegated_failed' })
    expect(s.delegatedRetries).toBeUndefined()
    expect(s.jobId).toBe('exec-1-acme:impl')
  })

  it('leaves a CONTAINER job dispatched later on the same step out of the budget', async () => {
    // The delegation record outlives the work it describes (its attempt log is the evidence for a
    // re-run), so a helper container round on the same step must not be re-driven on a budget
    // that belongs to external work which finished hours ago.
    const s = delegatedStep({ jobId: 'exec-1-fixer' } as Partial<PipelineStep>)
    const { controller: c } = controller()
    const result = await c.handleFailedPoll('ws-1', instance(s), s, failure('retryable'))
    expect(result).toMatchObject({ kind: 'job_failed' })
    expect(s.delegatedRetries).toBeUndefined()
  })
})
