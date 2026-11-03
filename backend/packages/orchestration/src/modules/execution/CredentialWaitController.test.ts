import { describe, expect, it, vi } from 'vitest'
import type { Clock, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { ConflictError, CredentialRequiredError } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  CredentialWaitController,
  type CredentialWaitControllerDeps,
} from './CredentialWaitController.js'
import { StepGraph } from './StepGraph.js'
import type { AdvanceResult } from './advance.js'

const NOW = 1_700_000_000_000

function run(over: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'running',
    currentStep: 1,
    steps: [
      { agentKind: 'requirements-review', state: 'done', progress: 1 },
      { agentKind: 'architect', state: 'working', progress: 0, startedAt: NOW - 1000 },
    ] as unknown as PipelineStep[],
    ...over,
  } as unknown as ExecutionInstance
}

function harness(initial: ExecutionInstance) {
  const stored = { instance: initial }
  const clock: Clock = { now: () => NOW }
  const stepGraph = new StepGraph(clock, defaultAgentKindRegistry())
  const stateMachine = {
    mutateInstance: vi.fn(
      async (_ws: string, _id: string, mutate: (i: ExecutionInstance) => void | Promise<void>) => {
        await mutate(stored.instance)
        return stored.instance
      },
    ),
    updateBlockProgress: vi.fn(async () => {}),
    emitInstance: vi.fn(async () => {}),
    ensureWaitingNotification: vi.fn(async () => {}),
    openDecisionPark: vi.fn((step: PipelineStep, proposal = '') => {
      step.approval = { id: 'appr_1', status: 'pending', proposal }
      stepGraph.pauseStepForInput(step)
      return 'appr_1'
    }),
  }
  const workRunner = { signalDecision: vi.fn(async () => {}) }
  const deps = {
    stateMachine,
    stepGraph,
    executionRepository: { get: vi.fn(async () => stored.instance) },
    clock,
    workRunner,
  } as unknown as CredentialWaitControllerDeps
  return { controller: new CredentialWaitController(deps), stored, stateMachine, workRunner }
}

const lapsed = () =>
  new CredentialRequiredError('No active claude credential', {
    vendor: 'claude',
    reason: 'password_required',
  })

describe('CredentialWaitController.guard', () => {
  it('parks the current step when an inline dispatch throws a lapsed lease', async () => {
    const h = harness(run())
    const result = await h.controller.guard('ws', 'exec_1', async () => {
      throw lapsed()
    })

    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    const step = h.stored.instance.steps[1]!
    expect(step.credentialWait).toEqual({ raisedAt: NOW })
    expect(step.approval).toMatchObject({ id: 'appr_1', status: 'pending' })
    expect(step.state).toBe('waiting_decision')
    expect(h.stored.instance.status).toBe('blocked')
    expect(h.stateMachine.ensureWaitingNotification).toHaveBeenCalled()
  })

  it('parks on the classified result an async dispatch site returns for the same refusal', async () => {
    const h = harness(run())
    const failed: AdvanceResult = {
      kind: 'job_failed',
      error: 'No active claude credential',
      failureKind: 'preflight',
      reason: 'password_required',
    }
    const result = await h.controller.guard('ws', 'exec_1', async () => failed)
    expect(result.kind).toBe('awaiting_decision')
    expect(h.stored.instance.steps[1]!.credentialWait).toBeTruthy()
  })

  it('passes every other outcome through untouched', async () => {
    const h = harness(run())
    const other: AdvanceResult = {
      kind: 'job_failed',
      error: 'GitHub is not connected',
      failureKind: 'preflight',
      reason: 'github_not_connected',
    }
    expect(await h.controller.guard('ws', 'exec_1', async () => other)).toBe(other)

    // A credential refusal the password cannot fix is a real failure, not a park.
    const expired = new CredentialRequiredError('expired', {
      vendor: 'claude',
      reason: 'subscription_expired',
    })
    await expect(
      h.controller.guard('ws', 'exec_1', async () => {
        throw expired
      }),
    ).rejects.toBe(expired)
    expect(h.stateMachine.mutateInstance).not.toHaveBeenCalled()
  })

  it('keeps the original failure when the run stopped while the dispatch was failing', async () => {
    const h = harness(run({ status: 'failed' }))
    const error = lapsed()
    await expect(
      h.controller.guard('ws', 'exec_1', async () => {
        throw error
      }),
    ).rejects.toBe(error)
    expect(h.stored.instance.steps[1]!.credentialWait).toBeUndefined()
  })
})

describe('CredentialWaitController.resume', () => {
  it('clears the park, keeps the step start time, and wakes the driver on the parked decision', async () => {
    const h = harness(run())
    await h.controller.guard('ws', 'exec_1', async () => {
      throw lapsed()
    })

    const renew = vi.fn(async () => {})
    const resumed = await h.controller.resume('ws', 'exec_1', renew)

    expect(renew).toHaveBeenCalledOnce()
    const step = resumed.steps[1]!
    expect(step.credentialWait).toBeNull()
    expect(step.approval).toBeNull()
    expect(step.state).toBe('working')
    expect(step.startedAt).toBe(NOW - 1000)
    expect(resumed.status).toBe('running')
    expect(h.workRunner.signalDecision).toHaveBeenCalledWith('ws', 'exec_1', 'appr_1', 'approved')
  })

  it('refuses a run that is not parked on a credential, before re-minting anything', async () => {
    const h = harness(run())
    const renew = vi.fn(async () => {})
    await expect(h.controller.resume('ws', 'exec_1', renew)).rejects.toBeInstanceOf(ConflictError)
    expect(renew).not.toHaveBeenCalled()
    expect(h.workRunner.signalDecision).not.toHaveBeenCalled()
  })

  it('refuses a run stopped while parked, which keeps the parked step as it stood', async () => {
    const h = harness(run())
    await h.controller.guard('ws', 'exec_1', async () => {
      throw lapsed()
    })
    h.stored.instance.status = 'failed'

    const renew = vi.fn(async () => {})
    await expect(h.controller.resume('ws', 'exec_1', renew)).rejects.toBeInstanceOf(ConflictError)
    expect(renew).not.toHaveBeenCalled()
    expect(h.stateMachine.updateBlockProgress).toHaveBeenCalledTimes(1)
  })
})
