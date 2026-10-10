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
import { createRecordingLogger } from '@cat-factory/kernel'
import { beforeEach, describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// The outbound `run.step_completed` edge: one delivery per step BOUNDARY, from the seams every
// path that finishes a step funnels through.
//
// The event exists because the run edges alone cannot answer "where is my task now" for a pipeline
// that runs for hours, and the rejected alternative it narrows (a per-step PROGRESS feed) is a
// firehose. So what these pin is the narrowing itself: it fires ON THE BOUNDARY, once, and it
// fires from EVERY seam. A regression that hooked only `settleStepAndAdvance` would deliver every
// ordinary step and silently drop every gate-resolved one, which is exactly the half of a pipeline
// a human was waiting on.
//
// Two more are about WHEN and WHAT ELSE. The boundary is published after the durable write and
// after any run edge the same settle pushes, on both seams, because a delivery pushed ahead of the
// compare-and-swap describes an advance that can still be lost; and it is a best-effort concern
// throughout, so the read it needs may not take the advance down with it.
//
// The rest pin what a receiver reads off the payload and cannot re-derive: that a SKIPPED step says
// so rather than arriving indistinguishable from a step that ran and reported nothing, which
// OCCURRENCE of a re-run step it is (the receiver's mandatory dedupe is keyed off that), that the
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

function makeMachine(
  options: { block?: Block | null; wireSink?: boolean; blockReadThrows?: boolean } = {},
) {
  const delivered: RunLifecycleEvent[] = []
  const blockReads: string[] = []
  /** Every observable side effect in the order it happened, for the ordering cases. */
  const order: string[] = []
  const block = options.block === undefined ? task : options.block
  const blockRepository: BlockRepository = {
    get: async (_ws: string, id: string) => {
      blockReads.push(id)
      if (options.blockReadThrows) throw new Error('block store unreachable')
      return block
    },
    update: async () => {},
  } as unknown as BlockRepository
  const sink: RunLifecycleSink = {
    runTransitioned: async (_ws: string, event: RunLifecycleEvent) => {
      delivered.push(event)
      order.push(`sink:${event.event}`)
    },
  }
  const machine = new RunStateMachine({
    executionRepository: {
      compareAndSwap: async () => {
        order.push('cas')
        return true
      },
    } as unknown as ExecutionRepository,
    blockRepository,
    events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
    workRunner: { signalDecision: async () => {} } as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 },
    logger: recordingLogger,
    stepGraph: {
      startStep: (s: PipelineStep) => {
        s.state = 'working'
        s.attempts = (s.attempts ?? 0) + 1
      },
      finishStep: (s: PipelineStep) => {
        s.state = 'done'
      },
    } as never,
    ...(options.wireSink === false ? {} : { runLifecycleSink: sink }),
  })
  return { machine, delivered, blockReads, order }
}

let recordingLogger = createRecordingLogger()
beforeEach(() => {
  recordingLogger = createRecordingLogger()
})

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

  it('publishes the boundary AFTER the durable write, on both settle seams', async () => {
    // The invariant `persistAndEmit` states for the local emit, held for the outbound one too. A
    // delivery pushed ahead of the compare-and-swap describes an advance that can still lose it (a
    // concurrent cancel, a `stop-reset`), leaving the receiver holding a step boundary no row
    // records and an `outcome` read off in-memory state alone.
    const advancing = makeMachine()
    await advancing.machine.settleStepAndAdvance(
      'ws_1',
      makeInstance([step('coder'), step('ci'), step('merger')], 0),
      /* isFinalStep */ false,
      {},
    )
    expect(advancing.order).toEqual(['cas', 'sink:run.step_completed'])

    // The gate seam settles on a snapshot already written under CAS, so what it must come after is
    // the run edge its own emit pushes, which is the case the FINAL-step assertion below pins for
    // the other seam. Published first, a released gate on the last step tells a receiver the run's
    // last step completed while the run still reads running.
    const gated = makeMachine()
    const instance = makeInstance([step('coder', { state: 'done' }), step('merger')], 1)
    instance.steps[1]!.approval = { id: 'appr_1', status: 'approved', proposal: '' } as never
    instance.status = 'done'
    await gated.machine.settleAdvancedGate('ws_1', instance, 1)
    expect(gated.delivered.map((e) => e.event)).toEqual(['run.completed', 'run.step_completed'])
    expect(stepEdges(gated.delivered)[0]!.step).toMatchObject({ index: 1, final: true })
  })

  it('names WHICH occurrence of a step boundary it is, so a re-run is its own delivery', async () => {
    // The engine re-runs a step in place (a companion bouncing its producer, a gate rewinding to an
    // upstream step), which settles the same INDEX again. The receiver's mandatory `deliveryId`
    // dedupe is keyed off this, so a boundary that could not say which pass it was would report a
    // rework loop as a single step completing.
    const { machine, delivered } = makeMachine()
    const instance = makeInstance([step('coder', { attempts: 3 }), step('merger')], 0)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(stepEdges(delivered)[0]!.step).toMatchObject({ index: 0, attempt: 3 })
  })

  it('reports attempt 1 for a step that never started', async () => {
    // A step the engine decided against running carries no start count, and the boundary still has
    // to name an occurrence. It settles exactly once, so 1 is the honest answer; leaving it absent
    // would put `…:undefined` in the key every skipped step of the run shares.
    const { machine, delivered } = makeMachine()
    const instance = makeInstance([step('tester', { skipped: true }), step('merger')], 0)

    await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(stepEdges(delivered)[0]!.step).toMatchObject({ outcome: 'skipped', attempt: 1 })
  })

  it('swallows a failed block read, publishes nothing, and says so', async () => {
    // Publishing is a notification concern, and the read it needs is a point lookup that can fail on
    // its own (a transient store error; on a mothership deployment it is a network round trip). Left
    // bare it throws out of whichever settle called it, on the advancing path before the cursor
    // moves and before the run is persisted, so a run would have to be re-driven because a webhook
    // projection could not read a title.
    //
    // Nothing is published either, rather than an event with an empty title: a headless job run is
    // suppressed by `block.internal`, so a read that did not ANSWER and a run with no block must
    // not collapse onto the same fall-through. The drop is warned, which is the whole bargain of a
    // best-effort swallow.
    //
    // Asked of the publisher DIRECTLY, for the reason the sink-unwired case below is: a settle reads
    // the block for its own reasons too (`blockIsTerminal`, an engine decision that SHOULD
    // propagate), and a store that failed every read could not tell the two apart.
    const { machine, delivered } = makeMachine({ blockReadThrows: true })

    await expect(
      machine.publishStepCompleted('ws_1', makeInstance([step('coder')], 0), 0),
    ).resolves.toBeUndefined()

    expect(delivered).toEqual([])
    expect(
      recordingLogger.lines.some(
        (line) => line.level === 'warn' && line.msg.includes('publishStepCompleted'),
      ),
    ).toBe(true)
  })

  it('publishes a settled step and every step it skipped, from one block read', async () => {
    // The list seam, for the one path that moves the cursor by more than one: a `bug-intake` step
    // deciding there is nothing to work marks the whole tail `skipped` and finalizes the run. With
    // no boundary at all a receiver is told the run completed and never learns the tail was cut,
    // which reads as a pipeline that had no steps. The block is read ONCE for the batch.
    const { machine, delivered, blockReads } = makeMachine()
    const instance = makeInstance([step('bug-intake'), step('coder'), step('merger')], 0)
    instance.steps[1]!.skipped = true
    instance.steps[2]!.skipped = true

    await machine.publishStepsCompleted('ws_1', instance, [0, 1, 2])

    expect(blockReads).toEqual(['task_login'])
    expect(stepEdges(delivered).map((e) => e.step)).toEqual([
      { index: 0, agentKind: 'bug-intake', outcome: 'completed', attempt: 1, final: false },
      { index: 1, agentKind: 'coder', outcome: 'skipped', attempt: 1, final: false },
      { index: 2, agentKind: 'merger', outcome: 'skipped', attempt: 1, final: true },
    ])
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
