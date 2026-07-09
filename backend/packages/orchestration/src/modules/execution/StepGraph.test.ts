import type { Clock, ExecutionInstance, PipelineStep } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { StepGraph } from './StepGraph.js'

const clock: Clock = { now: () => 0 }

function step(overrides: Partial<PipelineStep>): PipelineStep {
  return { agentKind: 'reviewer', state: 'working', progress: 0, ...overrides } as PipelineStep
}

function instance(steps: PipelineStep[], currentStep = 0): ExecutionInstance {
  return {
    id: 'run_1',
    blockId: 'blk_1',
    pipelineId: 'pl',
    pipelineName: 'P',
    steps,
    currentStep,
    status: 'running',
  } as ExecutionInstance
}

const rework = { feedback: 'redo' } as NonNullable<PipelineStep['rework']>

describe('StepGraph.loopCompanionProducer', () => {
  it('throws a diagnostic error when the companion has no preceding producer', () => {
    const graph = new StepGraph(clock)
    // A companion at index 0 has nothing before it to rework: companionProducerIndex → -1,
    // which previously indexed steps[-1] and crashed deep in a reset.
    const inst = instance([step({ agentKind: 'reviewer', companion: { attempts: 0 } as never })])
    expect(() => graph.loopCompanionProducer(inst, 0, rework)).toThrow(/no preceding producer/)
  })

  it('throws when the targeted step carries no companion budget', () => {
    const graph = new StepGraph(clock)
    const inst = instance([step({ agentKind: 'coder' }), step({ agentKind: 'reviewer' })])
    expect(() => graph.loopCompanionProducer(inst, 1, rework)).toThrow(/no companion budget/)
  })

  it('resets the companion step for re-run, CLEARING its approval', () => {
    // The iteration-cap `extra-round` resolution loops the producer back through this helper,
    // which resets every step from the producer through the companion (`resetStepForRerun`) —
    // and that NULLS the companion step's `approval`. So a caller that needs the gate's approval
    // id (e.g. to signal the driver) MUST capture it BEFORE calling this, not read it after.
    const graph = new StepGraph(clock)
    const inst = instance([
      step({ agentKind: 'coder', state: 'done', output: 'prev' }),
      step({
        agentKind: 'reviewer',
        state: 'waiting_decision',
        approval: { id: 'appr_1', status: 'pending', proposal: '' },
        companion: { attempts: 1, maxAttempts: 3 } as never,
      }),
    ])
    graph.loopCompanionProducer(inst, 1, rework)
    // The companion's approval is gone (this is the hazard the extra-round fix guards against).
    expect(inst.steps[1]!.approval).toBeNull()
    // The producer is re-armed with the rework feedback and the cursor rewound to it.
    expect(inst.currentStep).toBe(0)
    expect(inst.steps[0]!.rework).toEqual(rework)
    // The companion budget survives the reset (only the re-run scaffolding is cleared).
    expect(inst.steps[1]!.companion).toBeDefined()
  })
})
