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

describe('StepGraph.resetStepForRerun', () => {
  it('clears the liveness heartbeat so a re-run does not render a stale "active Ns ago"', () => {
    const graph = new StepGraph(clock)
    const s = step({
      state: 'working',
      startedAt: 1000,
      jobId: 'job_1',
      subtasks: { completed: 2, inProgress: 1, total: 5 },
      lastActivityAt: 4000,
    })
    graph.resetStepForRerun(s)
    expect(s.lastActivityAt).toBeNull()
    // Sanity: the other per-dispatch live fields reset alongside it.
    expect(s.subtasks).toBeUndefined()
    expect(s.jobId).toBeUndefined()
    expect(s.state).toBe('pending')
  })
})

// Two facts have to OUTLIVE a reset, because a reset is exactly what destroys the evidence that
// a step ran before: the external trace hangs every attempt's telemetry under one parent derived
// from (run, agent kind), so a parent rebuilt from the surviving attempt alone would start after
// its own earliest child and would report a cycle as a single round.
describe('StepGraph — cross-attempt step facts', () => {
  it('stamps firstStartedAt and counts the attempt on a fresh start', () => {
    const graph = new StepGraph({ now: () => 1_000 })
    const s = step({ state: 'pending', startedAt: null })
    graph.startStep(s)
    expect([s.startedAt, s.firstStartedAt, s.attempts]).toEqual([1_000, 1_000, 1])
  })

  it('does not re-count a step resuming from a human pause', () => {
    // startStep also runs when a parked step re-enters `working`. Counting that would inflate
    // every approval into an extra round.
    const graph = new StepGraph({ now: () => 5_000 })
    const s = step({ startedAt: 1_000, firstStartedAt: 1_000, attempts: 1, pausedAt: 2_000 })
    graph.startStep(s)
    expect([s.startedAt, s.firstStartedAt, s.attempts, s.pausedAt]).toEqual([1_000, 1_000, 1, null])
  })

  it('keeps firstStartedAt, attempts and dispatches across a re-run reset', () => {
    const graph = new StepGraph({ now: () => 9_000 })
    const s = step({
      startedAt: 1_000,
      firstStartedAt: 1_000,
      finishedAt: 2_000,
      attempts: 1,
      dispatches: [{ agentKind: 'coder', count: 1 }],
    })
    graph.resetStepForRerun(s)
    // The in-flight timings are cleared, as a reset must; the record of the earlier attempt is not.
    expect([s.startedAt, s.finishedAt]).toEqual([null, null])
    expect(s.firstStartedAt).toBe(1_000)
    expect(s.dispatches).toEqual([{ agentKind: 'coder', count: 1 }])

    graph.startStep(s)
    expect([s.startedAt, s.firstStartedAt, s.attempts]).toEqual([9_000, 1_000, 2])
  })
})
