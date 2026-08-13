import { describe, expect, it } from 'vitest'
import type { AgentJobUpdate, Block, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import {
  PollCompletionController,
  type PollCompletionControllerDeps,
} from './PollCompletionController.js'

// A harness SHUT DOWN under a job is the one container-loss shape the engine must not recover.
//
// The incident: an agent's own cleanup command matched the harness process and stopped it, the
// container exited 0, and the transport (which could only see a backend that stopped answering)
// called it an eviction. The engine then spent its crash budget re-dispatching the same step to a
// fresh container, where the same agent did the same thing, and the run finally failed as
// "infrastructure churn" after two full agent runs. The transport now says which of the two it
// saw; this pins that the engine acts on the distinction rather than recovering anyway.

function step(): PipelineStep {
  return { agentKind: 'coder', jobId: 'job-1' } as unknown as PipelineStep
}

function instance(): ExecutionInstance {
  return {
    id: 'exec-1',
    blockId: 'blk-1',
    currentStep: 2,
    steps: [{}, {}, {}],
  } as ExecutionInstance
}

const SHUTDOWN = {
  state: 'failed',
  error: 'The executor-harness shut down while this job was still running',
  harnessShutdown: true,
  detail: 'Container abc exited while the job was running. Exit: exit code 0',
} as unknown as Extract<AgentJobUpdate, { state: 'failed' }>

function controller(over: Partial<PollCompletionControllerDeps> = {}) {
  const calls = {
    containerErrored: 0,
    /** Every failure view the eviction recovery was handed, in order. */
    offeredToRecovery: [] as Array<{ evicted?: string }>,
  }
  const deps = {
    blockRepository: { get: async () => ({ id: 'blk-1' }) as Block },
    clock: { now: () => 1_000 },
    runStateMachine: { casPersist: async () => undefined },
    prReviewController: {},
    recordBackendDiagnostics: () => {},
    // Mirrors the real recovery's own first line (`if (!evicted) return null`), which is what
    // makes "it was consulted" and "it spent a budget" two different facts here.
    recoverContainerEviction: async (
      _workspaceId: string,
      _instance: ExecutionInstance,
      step: PipelineStep,
      failure: { evicted?: string },
    ) => {
      calls.offeredToRecovery.push(failure)
      if (!failure.evicted) return null
      step.evictionRecoveries = (step.evictionRecoveries ?? 0) + 1
      return { kind: 'continue' as const }
    },
    markContainerErrored: async () => {
      calls.containerErrored += 1
    },
    ...over,
  } as unknown as PollCompletionControllerDeps
  return { controller: new PollCompletionController(deps), calls }
}

describe('PollCompletionController: a harness shutdown', () => {
  it('fails the run with its own kind instead of the generic agent failure', async () => {
    const { controller: c } = controller()
    const result = await c.handleFailedPoll('ws-1', instance(), step(), SHUTDOWN)
    expect(result).toMatchObject({
      kind: 'job_failed',
      failureKind: 'harness_shutdown',
      detail: expect.stringContaining('exit code 0'),
    })
    expect(result).toMatchObject({ error: expect.stringContaining('shut down') })
  })

  it('spends no restart budget, because the view it carries names no eviction', async () => {
    // The assertion that matters: no recovery counter moves on a failure that is deterministic,
    // which is what turned one killed container into two full agent runs. The recovery is
    // reachable (a shutdown is asked about below every branch that settles a job without failing
    // the run), so what protects the budget is the view itself: a transport never sets `evicted`
    // beside `harnessShutdown`, and that absence is the recovery's own no-op condition.
    const s = step()
    const { controller: c, calls } = controller()
    await c.handleFailedPoll('ws-1', instance(), s, SHUTDOWN)
    expect(calls.offeredToRecovery).toHaveLength(1)
    expect(calls.offeredToRecovery[0]?.evicted).toBeUndefined()
    expect(s.evictionRecoveries).toBeUndefined()
    // The container still gets marked errored, so the failed run's details show it.
    expect(calls.containerErrored).toBe(1)
  })

  it('leaves an ordinary eviction to the recovery', async () => {
    const s = step()
    const { controller: c } = controller()
    const evicted = {
      state: 'failed',
      error: 'Job not found (container evicted or crashed)',
      evicted: 'crash',
    } as unknown as Extract<AgentJobUpdate, { state: 'failed' }>
    const result = await c.handleFailedPoll('ws-1', instance(), s, evicted)
    expect(result).toEqual({ kind: 'continue' })
    expect(s.evictionRecoveries).toBe(1)
  })

  it('lets a parked review settle its own killed investigator instead of failing the run', async () => {
    // A Challenge Investigator is a read-only SECOND OPINION dispatched off a parked `pr-reviewer`
    // step while a human curates findings. Whatever killed it, the human's curation is still live
    // and losing the whole run mid-review is a worse outcome than the one this failure kind
    // exists to prevent — so the shutdown verdict is asked BELOW this branch, not above it.
    let settledWith: string | undefined
    const { controller: c, calls } = controller({
      prReviewController: {
        recordChallengeFailure: async (
          _workspaceId: string,
          _instance: ExecutionInstance,
          _step: PipelineStep,
          error?: string,
        ) => {
          settledWith = error
          return { kind: 'awaiting_decision' as const, decisionId: 'appr_1' }
        },
      },
    } as unknown as Partial<PollCompletionControllerDeps>)
    const challenging = {
      agentKind: 'pr-reviewer',
      jobId: 'job-1',
      prReview: { status: 'challenging' },
    } as unknown as PipelineStep
    const result = await c.handleFailedPoll('ws-1', instance(), challenging, SHUTDOWN)
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(settledWith).toContain('shut down')
    // The run is not failed, so nothing marks the step's container errored either.
    expect(calls.containerErrored).toBe(0)
  })
})
