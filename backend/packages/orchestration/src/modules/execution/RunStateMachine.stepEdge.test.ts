import type {
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
  RunLifecycleEvent,
  RunLifecycleSink,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// The outbound `run.step_completed` edge: one delivery per step BOUNDARY, from the two methods
// every path that finishes a step funnels through.
//
// The event exists because the run edges alone cannot answer "where is my task now" for a pipeline
// that runs for hours, and the rejected alternative it narrows (a per-step PROGRESS feed) is a
// firehose. So what these pin is the narrowing itself: it fires ON THE BOUNDARY, once, and it
// fires from BOTH seams. A regression that hooked only `settleStepAndAdvance` would deliver every
// ordinary step and silently drop every gate-resolved one, which is exactly the half of a pipeline
// a human was waiting on.
//
// The rest pin what a receiver reads off the payload and cannot re-derive: that a SKIPPED step says
// so rather than arriving indistinguishable from a step that ran and reported nothing, that the
// LAST step is marked as such, that a headless job's steps stay unpublished like its run edges,
// and that the delivery costs nothing at all when no sink is wired.

function step(agentKind: string, over: Partial<PipelineStep> = {}): PipelineStep {
  return { agentKind, state: 'pending', progress: 0, ...over } as unknown as PipelineStep
}

function makeInstance(steps: PipelineStep[], currentStep: number): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_login',
    pipelineId: 'pl_full',
    pipelineName: 'Full',
    steps,
    currentStep,
    status: 'running',
    createdAt: 1_699_000_000_000,
  } as ExecutionInstance
}

const task = { id: 'task_login', title: 'Add passkey login', status: 'in_progress' } as Block
const internalAnchor = { id: 'task_login', title: 'brief', internal: true } as unknown as Block

function makeMachine(options: { block?: Block | null; wireSink?: boolean } = {}) {
  const delivered: RunLifecycleEvent[] = []
  const blockReads: string[] = []
  const block = options.block === undefined ? task : options.block
  const blockRepository: BlockRepository = {
    get: async (_ws: string, id: string) => {
      blockReads.push(id)
      return block
    },
    update: async () => {},
  } as unknown as BlockRepository
  const sink: RunLifecycleSink = {
    runTransitioned: async (_ws: string, event: RunLifecycleEvent) => {
      delivered.push(event)
    },
  }
  const machine = new RunStateMachine({
    executionRepository: { compareAndSwap: async () => true } as unknown as ExecutionRepository,
    blockRepository,
    events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
    workRunner: { signalDecision: async () => {} } as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 },
    stepGraph: {
      startStep: (s: PipelineStep) => {
        s.state = 'working'
      },
      finishStep: (s: PipelineStep) => {
        s.state = 'done'
      },
    } as never,
    ...(options.wireSink === false ? {} : { runLifecycleSink: sink }),
  })
  return { machine, delivered, blockReads }
}

/** The step edges only, so a case can assert them without the run edges the same funnel pushes. */
const stepEdges = (delivered: RunLifecycleEvent[]) =>
  delivered.filter((e) => e.event === 'run.step_completed')

describe('RunStateMachine: the outbound run.step_completed edge', () => {
  it('pushes the settled step when an ordinary step advances the run', async () => {
    const { machine, delivered } = makeMachine()
    const instance = makeInstance([step('coder'), step('ci'), step('merger')], 0)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(stepEdges(delivered)).toHaveLength(1)
    expect(stepEdges(delivered)[0]).toMatchObject({
      event: 'run.step_completed',
      runId: 'exec_1',
      taskId: 'task_login',
      taskTitle: 'Add passkey login',
      // The step that SETTLED, not the one the run moved on to. Reading the cursor after the
      // increment would report every boundary as the step that has not run yet.
      step: { index: 0, agentKind: 'coder', outcome: 'completed', final: false },
    })
  })

  it('pushes from the GATE seam too, naming the gate step the human just released', async () => {
    // The second of the two seams, and the one a hook-per-caller design drops: `advanceRunPastGate`
    // has already moved the cursor by the time the side effects run, so the settling step is the
    // index the caller passed rather than anything readable off the instance.
    const { machine, delivered } = makeMachine()
    const instance = makeInstance(
      [step('coder', { state: 'done' }), step('architect'), step('merger')],
      2,
    )
    instance.steps[1]!.approval = { id: 'appr_1', status: 'approved', proposal: '' } as never

    await machine.settleAdvancedGate('ws_1', instance, 1)

    expect(stepEdges(delivered)).toHaveLength(1)
    expect(stepEdges(delivered)[0]!.step).toMatchObject({
      index: 1,
      agentKind: 'architect',
      outcome: 'completed',
      final: false,
    })
  })

  it('says a SKIPPED step was skipped rather than completed', async () => {
    // The whole reason `outcome` exists. A gated skip marks the step done with no output, which is
    // byte-for-byte a step that ran and reported nothing, so a receiver counting delivered work
    // would score an estimate-gated tester exactly like a tester that found nothing to say.
    const { machine, delivered } = makeMachine()
    const instance = makeInstance([step('tester', { skipped: true }), step('merger')], 0)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(stepEdges(delivered)[0]!.step).toMatchObject({ agentKind: 'tester', outcome: 'skipped' })
  })

  it('marks the run FINAL step, and pushes it after the run edge that settles the run', async () => {
    // Two facts a receiver reading its queue in order depends on. `final` tells it a terminal event
    // is coming rather than leaving it to compare an index against a step count it does not have;
    // the ORDER means it never sees the run's last step complete while the run still reads running.
    const { machine, delivered } = makeMachine()
    const instance = makeInstance([step('coder'), step('merger')], 1)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ true, {})

    expect(delivered.map((e) => e.event)).toEqual(['run.completed', 'run.step_completed'])
    expect(stepEdges(delivered)[0]!.step).toMatchObject({ index: 1, final: true })
  })

  it('suppresses a HEADLESS job run, exactly as the run edges do', async () => {
    // A `/api/v1/jobs` run is anchored on an internal block whose "task" is the caller's brief, and
    // `GET /api/v1/jobs/:id` plus its SSE stream already serve it. Publishing its steps would push
    // an id no external receiver can address anything with.
    const { machine, delivered } = makeMachine({ block: internalAnchor })
    const instance = makeInstance([step('researcher'), step('merger')], 0)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(delivered).toEqual([])
  })

  it('reads no block at all when no sink is wired', async () => {
    // The guard is ordered sink-first on purpose: a step boundary is cheap but it is not free, and
    // a deployment that never wired the webhook module must not start paying a point read per step
    // for an event nobody receives.
    //
    // Asked of the publisher DIRECTLY rather than through a settle, because a settle reads the
    // block for its own reasons (`blockIsTerminal`) and a count taken around it could not tell the
    // two readers apart.
    const unwired = makeMachine({ wireSink: false })
    await unwired.machine.publishStepCompleted('ws_1', makeInstance([step('coder')], 0), 0)
    expect(unwired.delivered).toEqual([])
    expect(unwired.blockReads).toEqual([])

    const wired = makeMachine()
    await wired.machine.publishStepCompleted('ws_1', makeInstance([step('coder')], 0), 0)
    expect(wired.blockReads).toEqual(['task_login'])
  })
})
