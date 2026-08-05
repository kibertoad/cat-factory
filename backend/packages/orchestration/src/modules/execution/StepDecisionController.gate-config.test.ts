import { describe, expect, it, vi } from 'vitest'
import type { ExecutionInstance, GateActor, PipelineStep } from '@cat-factory/kernel'
import { ForbiddenError } from '@cat-factory/kernel'
import { defaultAgentKindRegistry } from '@cat-factory/agents'
import {
  StepDecisionController,
  type StepDecisionControllerDeps,
} from './StepDecisionController.js'

// The two things a per-step gate config changes about resolving a gate, at the ONE seam that
// enforces them: an approver policy refuses a caller it does not name, and a quorum records an
// approval without advancing the run until it is met.
//
// Driven through the controller with fake engine primitives rather than end-to-end, because the
// interesting states (two DIFFERENT signed-in people approving the same gate) are exactly the
// ones a single-caller integration test cannot produce.

function gatedStep(over: Partial<PipelineStep['approval']> = {}): PipelineStep {
  return {
    agentKind: 'architect',
    state: 'done',
    progress: 1,
    requiresApproval: true,
    output: 'a proposal',
    approval: { id: 'appr_1', status: 'pending', proposal: 'a proposal', ...over },
  } as unknown as PipelineStep
}

function instance(step: PipelineStep): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'blocked',
    currentStep: 0,
    steps: [step, { agentKind: 'coder', state: 'pending', progress: 0 } as unknown as PipelineStep],
  } as unknown as ExecutionInstance
}

function user(id: string, role: GateActor['role'] = 'member'): GateActor {
  return { id, kind: 'user', role, label: id }
}

/**
 * Engine primitives reduced to what a gate resolution touches. `mutateInstance` applies the
 * mutation to the live object and hands it back, which is the behaviour the real CAS has on an
 * uncontended write — the contention path has its own tests.
 */
function fakeDeps(inst: ExecutionInstance) {
  const emitInstance = vi.fn(async () => {})
  const settleAdvancedGate = vi.fn(async () => {})
  const advanceRunPastGate = vi.fn((i: ExecutionInstance) => {
    i.currentStep = 1
    return true
  })
  const deps = {
    // The real registry, because `assertNotIterativeGate` asks it whether the step's kind carries
    // the interview-gate trait — a stub answering "no trait" would pass the test while proving
    // nothing about a step kind that does.
    agentKindRegistry: defaultAgentKindRegistry(),
    clock: { now: () => 1_000 },
    runStateMachine: {
      mutateInstance: async (
        _ws: string,
        _id: string,
        apply: (i: ExecutionInstance) => unknown,
      ) => {
        await apply(inst)
        return inst
      },
      emitInstance,
      settleAdvancedGate,
      advanceRunPastGate,
    } as never,
    // Only the request-changes path reaches these: it re-runs the step and wakes the durable
    // driver, where approve/reject settle through `runStateMachine` alone.
    stepGraph: { startStep: vi.fn(), rerunProducerThrough: vi.fn() } as never,
    workRunner: { signalDecision: vi.fn(async () => {}) } as never,
    requireWorkspace: vi.fn(async () => ({})),
  } as unknown as StepDecisionControllerDeps
  return { deps, emitInstance, settleAdvancedGate, advanceRunPastGate }
}

describe('approving a gate that names its approvers', () => {
  it('refuses a caller the policy does not name, leaving the gate pending', async () => {
    const step = gatedStep({ approverPolicy: { userIds: ['usr_release'] } })
    const inst = instance(step)
    const { deps, advanceRunPastGate } = fakeDeps(inst)
    const controller = new StepDecisionController(deps)

    await expect(
      controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_other')),
    ).rejects.toThrow(ForbiddenError)
    expect(step.approval?.status).toBe('pending')
    expect(advanceRunPastGate).not.toHaveBeenCalled()
  })

  it('refuses a machine key against ANY policy — a shared credential is nobody the policy named', async () => {
    const step = gatedStep({ approverPolicy: { roles: ['member'] } })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await expect(
      controller.approveStep(
        'ws_1',
        'exec_1',
        'appr_1',
        {},
        {
          id: 'pak_1',
          kind: 'api-key',
          role: null,
        },
      ),
    ).rejects.toMatchObject({ details: { reason: 'gate_approver_identity_required' } })
  })

  it('governs REJECT too, not only approve', async () => {
    // A policy that let a non-approver reject would gate nothing — it would only choose which
    // button the wrong person presses.
    const step = gatedStep({ approverPolicy: { userIds: ['usr_release'] } })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await expect(
      controller.rejectStep('ws_1', 'exec_1', 'appr_1', 'no', user('usr_other')),
    ).rejects.toThrow(ForbiddenError)
    expect(step.approval?.status).toBe('pending')
  })

  it('admits a workspace admin the policy does not list', async () => {
    const step = gatedStep({ approverPolicy: { userIds: ['usr_release'] } })
    const { deps, settleAdvancedGate } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_boss', 'admin'))
    expect(step.approval?.status).toBe('approved')
    expect(settleAdvancedGate).toHaveBeenCalled()
  })
})

describe('approving a gate that demands a quorum', () => {
  it('records the first approval WITHOUT advancing, then advances on the second', async () => {
    const step = gatedStep({ requiredApprovals: 2 })
    const inst = instance(step)
    const { deps, emitInstance, settleAdvancedGate, advanceRunPastGate } = fakeDeps(inst)
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_1'))
    expect(step.approval?.status).toBe('pending')
    expect(step.approval?.approvals).toEqual([{ actorId: 'usr_1', actorLabel: 'usr_1', at: 1_000 }])
    expect(advanceRunPastGate).not.toHaveBeenCalled()
    expect(settleAdvancedGate).not.toHaveBeenCalled()
    // The tally still has to reach the board, or the first approver sees nothing happen at all.
    expect(emitInstance).toHaveBeenCalled()

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_2'))
    expect(step.approval?.status).toBe('approved')
    expect(step.approval?.approvals?.map((a) => a.actorId)).toEqual(['usr_1', 'usr_2'])
    expect(settleAdvancedGate).toHaveBeenCalledTimes(1)
  })

  it('does not let ONE person clear a two-person gate by approving twice', async () => {
    const step = gatedStep({ requiredApprovals: 2 })
    const { deps, settleAdvancedGate } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_1'))
    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_1'))
    expect(step.approval?.status).toBe('pending')
    expect(step.approval?.approvals).toHaveLength(1)
    expect(settleAdvancedGate).not.toHaveBeenCalled()
  })

  it('carries a human edit made on the approval that MEETS the quorum', async () => {
    const step = gatedStep({ requiredApprovals: 2 })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_1'))
    await controller.approveStep(
      'ws_1',
      'exec_1',
      'appr_1',
      { proposal: 'a corrected proposal' },
      user('usr_2'),
    )
    expect(step.output).toBe('a corrected proposal')
    expect(step.approval?.proposal).toBe('a corrected proposal')
  })
})

describe('the policy governs REQUEST CHANGES too', () => {
  it('refuses a caller the policy does not name, leaving the gate pending', async () => {
    // The third resolution, asserted here rather than assumed from the other two: each of the
    // three settles the checkpoint, and a bounce back to the agent with someone else's feedback
    // folded in is a resolution the wrong person should not be able to make either.
    const step = gatedStep({ approverPolicy: { userIds: ['usr_release'] } })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await expect(
      controller.requestStepChanges(
        'ws_1',
        'exec_1',
        'appr_1',
        { feedback: 'redo it' },
        user('usr_other'),
      ),
    ).rejects.toThrow(ForbiddenError)
    expect(step.approval?.status).toBe('pending')
    expect(step.approval?.feedback).toBeUndefined()
  })

  it('admits a caller the policy names', async () => {
    const step = gatedStep({ approverPolicy: { userIds: ['usr_release'] } })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.requestStepChanges(
      'ws_1',
      'exec_1',
      'appr_1',
      { feedback: 'redo it' },
      user('usr_release'),
    )
    expect(step.approval?.status).toBe('changes_requested')
  })
})

describe('editing the proposal under an unmet quorum', () => {
  it('is REFUSED, so an early approver cannot move the artifact under the others', async () => {
    // A quorum votes on ONE artifact. Accepting the edit here would leave every approval already
    // recorded standing against text its approver never saw, and let the next approver overwrite
    // it again. A silent rewrite is exactly what the recorded tally exists to make impossible.
    const step = gatedStep({ requiredApprovals: 2 })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await expect(
      controller.approveStep('ws_1', 'exec_1', 'appr_1', { proposal: 'my rewrite' }, user('usr_1')),
    ).rejects.toMatchObject({ details: { reason: 'proposal_not_editable_until_quorum' } })
    // Refused whole: neither the edit nor the vote landed, so nothing half-applied.
    expect(step.output).toBe('a proposal')
    expect(step.approval?.approvals ?? []).toHaveLength(0)
  })

  it('leaves a plain approve on the same gate working', async () => {
    const step = gatedStep({ requiredApprovals: 2 })
    const { deps } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_1'))
    expect(step.approval?.approvals).toHaveLength(1)
  })
})

describe('re-approving a gate that is already through', () => {
  it('stays a no-op for someone the policy does not name', async () => {
    // The idempotent no-op is answered before the policy: a second click on a settled gate
    // changes nothing, and reporting 403 for it would make the documented idempotence hold only
    // for the people the policy happens to list.
    const step = gatedStep({
      status: 'approved',
      approverPolicy: { userIds: ['usr_release'] },
    })
    const { deps, settleAdvancedGate } = fakeDeps(instance(step))
    const controller = new StepDecisionController(deps)

    await controller.approveStep('ws_1', 'exec_1', 'appr_1', {}, user('usr_other'))
    expect(step.approval?.status).toBe('approved')
    expect(settleAdvancedGate).not.toHaveBeenCalled()
  })
})
