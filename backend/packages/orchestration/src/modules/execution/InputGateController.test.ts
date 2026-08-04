import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Block, ExecutionInstance, PipelineStep, WorkspaceSettings } from '@cat-factory/kernel'
import { ConflictError, DEFAULT_WORKSPACE_SETTINGS } from '@cat-factory/kernel'
import { InputGateController, type InputGateControllerDeps } from './InputGateController.js'

// The controller owns the gate's placement + park/resume flow; the check itself is kernel's pure
// `evaluateInputGate` (tested separately). These fakes stand in for the engine spine so each
// branch is asserted without a DB, a durable driver or a model.

const NOW = 1_700_000_000_000

function step(over: Partial<PipelineStep> = {}): PipelineStep {
  return {
    agentKind: 'requirements-review',
    state: 'working',
    progress: 0,
    ...over,
  } as unknown as PipelineStep
}

function instance(over: Partial<ExecutionInstance> = {}): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'blk_1',
    status: 'running',
    currentStep: 0,
    steps: [step()],
    ...over,
  } as unknown as ExecutionInstance
}

function block(over: Partial<Block> = {}): Block {
  return {
    id: 'blk_1',
    title: 'Add retries to the webhook sender',
    description: 'Retry three times with exponential backoff whenever the receiver answers 5xx.',
    ...over,
  } as unknown as Block
}

function fakeDeps(over: Partial<InputGateControllerDeps> = {}) {
  const stored: { instance: ExecutionInstance | null } = { instance: null }
  const executionRepository = {
    get: vi.fn(async () => stored.instance),
  }
  const stateMachine = {
    casPersist: vi.fn(async () => {}),
    parkStepOnDecision: vi.fn(async (_ws: string, inst: ExecutionInstance, s: PipelineStep) => {
      s.state = 'waiting_decision'
      s.approval = { id: 'appr_1', status: 'pending', proposal: '' }
      inst.status = 'blocked'
      return { kind: 'awaiting_decision', decisionId: 'appr_1' } as const
    }),
    raiseDecisionRequired: vi.fn(async () => {}),
    emitInstance: vi.fn(async () => {}),
    mutateInstance: vi.fn(
      async (_ws: string, _id: string, mutate: (i: ExecutionInstance) => void | Promise<void>) => {
        const inst = stored.instance!
        await mutate(inst)
        return inst
      },
    ),
  }
  const stepGraph = {
    startStep: vi.fn((s: PipelineStep) => {
      s.state = 'working'
    }),
  }
  const settings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS }
  const deps = {
    blockRepository: { get: vi.fn(async () => block()) },
    executionRepository,
    workRunner: { signalDecision: vi.fn(async () => {}) },
    stateMachine,
    stepGraph,
    clock: { now: () => NOW },
    workspaceSettingsService: { get: vi.fn(async () => settings) },
    ...over,
  } as unknown as InputGateControllerDeps
  return { deps, stored, settings, stateMachine, stepGraph, executionRepository }
}

describe('InputGateController.evaluate', () => {
  let harness: ReturnType<typeof fakeDeps>
  let gate: InputGateController

  beforeEach(() => {
    harness = fakeDeps()
    gate = new InputGateController(harness.deps)
  })

  it('records a clean verdict and lets the run proceed', async () => {
    const inst = instance()
    const result = await gate.evaluate('ws', inst, inst.steps[0]!, block())
    expect(result).toBeNull()
    expect(inst.inputGate).toEqual({
      status: 'passed',
      mode: 'standard',
      issues: [],
      checkedAt: NOW,
    })
    expect(harness.stateMachine.casPersist).toHaveBeenCalled()
    expect(harness.stateMachine.parkStepOnDecision).not.toHaveBeenCalled()
  })

  it('parks the run on a blocking finding, before anything dispatches', async () => {
    const inst = instance()
    const result = await gate.evaluate('ws', inst, inst.steps[0]!, block({ description: '' }))
    expect(result).toEqual({ kind: 'awaiting_decision', decisionId: 'appr_1' })
    expect(inst.inputGate?.status).toBe('blocked')
    expect(inst.inputGate?.issues).toEqual([{ code: 'description_missing', severity: 'blocking' }])
    // A park nobody is told about is a run that waits forever.
    expect(harness.stateMachine.raiseDecisionRequired).toHaveBeenCalled()
  })

  it('records advisory findings without parking', async () => {
    const inst = instance()
    const result = await gate.evaluate('ws', inst, inst.steps[0]!, block({ description: 'faster' }))
    expect(result).toBeNull()
    expect(inst.inputGate?.status).toBe('passed')
    expect(inst.inputGate?.issues).toEqual([{ code: 'description_thin', severity: 'advisory' }])
  })

  it('records `off`: never an empty `passed`: when the workspace turned the gate off', async () => {
    harness.settings.inputGateMode = 'off'
    const inst = instance()
    const result = await gate.evaluate('ws', inst, inst.steps[0]!, block({ description: '' }))
    expect(result).toBeNull()
    expect(inst.inputGate).toEqual({ status: 'off', mode: 'off', issues: [], checkedAt: NOW })
  })

  it('records `off` when the settings seam is unwired, rather than parking on a policy nobody chose', async () => {
    const bare = fakeDeps({ workspaceSettingsService: undefined })
    const inst = instance()
    const result = await new InputGateController(bare.deps).evaluate(
      'ws',
      inst,
      inst.steps[0]!,
      block({ description: '' }),
    )
    expect(result).toBeNull()
    expect(inst.inputGate?.status).toBe('off')
  })

  it('records `off` when the settings read FAILS, an unreadable policy is not a mandate to park', async () => {
    const broken = fakeDeps({
      workspaceSettingsService: {
        get: vi.fn(async () => {
          throw new Error('settings store unreachable')
        }),
      } as unknown as InputGateControllerDeps['workspaceSettingsService'],
    })
    const inst = instance()
    const result = await new InputGateController(broken.deps).evaluate(
      'ws',
      inst,
      inst.steps[0]!,
      block({ description: '' }),
    )
    expect(result).toBeNull()
    expect(inst.inputGate?.status).toBe('off')
  })

  it('is idempotent under replay: a settled verdict is never re-judged', async () => {
    const inst = instance({
      inputGate: { status: 'overridden', mode: 'standard', issues: [], checkedAt: 1 },
    })
    const result = await gate.evaluate('ws', inst, inst.steps[0]!, block({ description: '' }))
    expect(result).toBeNull()
    // The human's waiver survives, a re-evaluation would park the run they just released.
    expect(inst.inputGate?.status).toBe('overridden')
    expect(harness.stateMachine.parkStepOnDecision).not.toHaveBeenCalled()
  })

  it('does not evaluate past the first step, where parking would save nothing', async () => {
    const inst = instance({ currentStep: 2, steps: [step(), step(), step()] })
    const result = await gate.evaluate('ws', inst, inst.steps[2]!, block({ description: '' }))
    expect(result).toBeNull()
    expect(inst.inputGate).toBeUndefined()
  })
})

describe('InputGateController.resolve', () => {
  let harness: ReturnType<typeof fakeDeps>
  let gate: InputGateController

  const parked = (over: Partial<ExecutionInstance> = {}): ExecutionInstance =>
    instance({
      status: 'blocked',
      steps: [
        step({
          state: 'waiting_decision',
          approval: { id: 'appr_1', status: 'pending', proposal: 'incomplete' },
        }),
      ],
      inputGate: {
        status: 'blocked',
        mode: 'standard',
        issues: [{ code: 'description_missing', severity: 'blocking' }],
        checkedAt: 1,
      },
      ...over,
    })

  beforeEach(() => {
    harness = fakeDeps()
    gate = new InputGateController(harness.deps)
  })

  it('proceed waives the findings and resumes the SAME step', async () => {
    harness.stored.instance = parked()
    const settled = await gate.resolve('ws', 'exec_1', 'proceed', 'usr_7')
    expect(settled).toMatchObject({
      status: 'overridden',
      overriddenBy: 'usr_7',
      overriddenAt: NOW,
      // What was waived stays on the record.
      issues: [{ code: 'description_missing', severity: 'blocking' }],
    })
    const inst = harness.stored.instance!
    expect(inst.steps[0]!.approval).toBeNull()
    expect(inst.status).toBe('running')
    expect(harness.stepGraph.startStep).toHaveBeenCalledWith(inst.steps[0])
    expect(harness.deps.workRunner.signalDecision).toHaveBeenCalledWith(
      'ws',
      'exec_1',
      'appr_1',
      'approved',
    )
  })

  it('recheck clears the park only when the gaps are genuinely gone', async () => {
    harness.stored.instance = parked()
    const settled = await gate.resolve('ws', 'exec_1', 'recheck', 'usr_7')
    expect(settled.status).toBe('passed')
    expect(settled.issues).toEqual([])
    expect(harness.stored.instance!.steps[0]!.approval).toBeNull()
    expect(harness.deps.workRunner.signalDecision).toHaveBeenCalled()
  })

  it('recheck on a still-broken task refreshes the findings and stays parked on the SAME decision', async () => {
    harness.stored.instance = parked()
    harness.deps.blockRepository.get = vi.fn(async () => block({ description: 'TBD' }))
    const settled = await gate.resolve('ws', 'exec_1', 'recheck', 'usr_7')
    expect(settled.status).toBe('blocked')
    // The finding MOVED (missing → placeholder), so a partial fix reads as progress.
    expect(settled.issues).toEqual([{ code: 'description_placeholder', severity: 'blocking' }])
    const inst = harness.stored.instance!
    // The durable driver is still waiting on `appr_1`; minting a fresh id would strand it.
    expect(inst.steps[0]!.approval).toEqual({
      id: 'appr_1',
      status: 'pending',
      proposal: 'incomplete',
    })
    expect(harness.deps.workRunner.signalDecision).not.toHaveBeenCalled()
  })

  it('refuses a run that is not parked on the gate', async () => {
    harness.stored.instance = instance()
    await expect(gate.resolve('ws', 'exec_1', 'proceed', null)).rejects.toBeInstanceOf(
      ConflictError,
    )
  })

  it('refuses when another surface already answered the park', async () => {
    // The pre-read sees a parked gate; by the time the CAS callback runs, the approval is gone.
    harness.stored.instance = parked()
    const inst = harness.stored.instance
    harness.stateMachine.mutateInstance.mockImplementationOnce(async (_ws, _id, mutate) => {
      inst.steps[0]!.approval = null
      await mutate(inst)
      return inst
    })
    await expect(gate.resolve('ws', 'exec_1', 'proceed', null)).rejects.toBeInstanceOf(
      ConflictError,
    )
  })
})
