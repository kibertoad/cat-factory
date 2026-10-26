import { describe, expect, it, vi } from 'vitest'
import type {
  AgentExecutor,
  Block,
  ExecutionInstance,
  GateDefinition,
  PipelineStep,
} from '@cat-factory/kernel'
import type { DescriptorField } from '@cat-factory/contracts'
import { GateStepController, type GateStepControllerDeps } from './GateStepController.js'
import type { GateHelperDispatcher } from './GateHelperDispatcher.js'

// What a polling gate's parameters freeze to on first entry. The builder form does not seed a
// field's declared default, so a step the author left empty reaches here with no value: the gate
// must still receive the default its own registration stated, or the default means nothing.
//
// Driven on the controller directly because the freeze is pure state on an in-memory step; the
// probe passes at once so the evaluation ends on the first poll.

const FIELDS: DescriptorField[] = [
  { key: 'soakMinutes', label: 'Soak window', type: 'number', default: '15' },
  { key: 'channel', label: 'Channel', type: 'text' },
]

function gateStep(fields?: Record<string, unknown>): PipelineStep {
  return {
    agentKind: 'soak-gate',
    state: 'running',
    ...(fields ? { stepOptions: { gateConfig: { fields } } } : {}),
  } as unknown as PipelineStep
}

function run(step: PipelineStep): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    status: 'running',
    currentStep: 0,
    steps: [step],
  } as unknown as ExecutionInstance
}

const gate = {
  kind: 'soak-gate',
  helperKind: 'ci-fixer',
  wired: () => true,
  unwiredOutput: 'skipped',
  probe: async () => ({ status: 'pass', headSha: null }),
  onExhausted: async () => ({ error: 'spent' }),
} as unknown as GateDefinition

async function frozenConfig(step: PipelineStep): Promise<unknown> {
  const deps: GateStepControllerDeps = {
    agentExecutor: {} as AgentExecutor,
    clock: { now: () => 0 } as GateStepControllerDeps['clock'],
    runStateMachine: {} as GateStepControllerDeps['runStateMachine'],
    runInitiatorScope: ((_scope: unknown, fn: () => unknown) =>
      fn()) as GateStepControllerDeps['runInitiatorScope'],
    resolveRiskPolicy: async () => ({
      ciMaxAttempts: 2,
      releaseMaxAttempts: 2,
      releaseWatchWindowMinutes: 30,
      humanReviewGraceMinutes: 10,
    }),
    declaredGateFields: (kind) => (kind === 'soak-gate' ? FIELDS : undefined),
    recordStepResult: vi.fn(async () => ({ kind: 'advanced' }) as never),
  }
  const controller = new GateStepController(deps, {} as GateHelperDispatcher)
  await controller.evaluate('ws_1', run(step), step, { id: 'task_1' } as Block, true, gate)
  return step.gate?.config
}

describe('GateStepController: the parameters frozen onto a gate', () => {
  it('fills a parameter the step left empty with the gate-declared default', async () => {
    expect(await frozenConfig(gateStep())).toEqual({ soakMinutes: 15 })
  })

  it('fills a blank value with the default too, so a headless blank cannot suppress it', async () => {
    expect(await frozenConfig(gateStep({ soakMinutes: '' }))).toEqual({ soakMinutes: 15 })
  })

  it('keeps an explicit value over the default', async () => {
    expect(await frozenConfig(gateStep({ soakMinutes: 60, channel: '#ops' }))).toEqual({
      soakMinutes: 60,
      channel: '#ops',
    })
  })
})
