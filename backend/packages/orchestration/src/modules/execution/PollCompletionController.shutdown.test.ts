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
  const calls = { recovered: 0, containerErrored: 0 }
  const deps = {
    blockRepository: { get: async () => ({ id: 'blk-1' }) as Block },
    clock: { now: () => 1_000 },
    runStateMachine: { casPersist: async () => undefined },
    prReviewController: {},
    recordBackendDiagnostics: () => {},
    recoverContainerEviction: async () => {
      calls.recovered += 1
      return null
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

  it('never reaches the eviction recovery, so no restart budget is spent', async () => {
    // The assertion that matters: the recovery is not merely declining to recover, it is not
    // consulted. Reaching it would increment the step's recovery counter on a failure that is
    // deterministic, which is what turned one killed container into two full agent runs.
    const { controller: c, calls } = controller()
    await c.handleFailedPoll('ws-1', instance(), step(), SHUTDOWN)
    expect(calls.recovered).toBe(0)
    // The container still gets marked errored, so the failed run's details show it.
    expect(calls.containerErrored).toBe(1)
  })

  it('leaves an ordinary eviction to the recovery', async () => {
    const { controller: c, calls } = controller()
    const evicted = {
      state: 'failed',
      error: 'Job not found (container evicted or crashed)',
      evicted: 'crash',
    } as unknown as Extract<AgentJobUpdate, { state: 'failed' }>
    await c.handleFailedPoll('ws-1', instance(), step(), evicted)
    expect(calls.recovered).toBe(1)
  })
})
