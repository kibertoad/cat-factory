import { describe, expect, it, vi } from 'vitest'
import type { ExecutionInstance, FollowUpsStepState, PipelineStep } from '@cat-factory/kernel'
import { createRecordingLogger } from '@cat-factory/kernel'
import { FollowUpGateController } from './FollowUpGateController.js'
import { followUpsToSendBack } from './followUp.logic.js'

// What the follow-up gate does when the send-back budget runs out with a human's decision still
// undelivered: the case that used to be indistinguishable from an ordinary finish.
//
// The gate has four dispositions and three of them used to answer the same `false`, so the caller
// could not tell "nothing to send" from "a decision is about to be thrown away". The second one
// advanced the run in silence: the items stayed `answered` with `sentToCoder` false forever, which
// reads exactly like answers the Coder applied.
//
// Driven here rather than in the conformance suite deliberately. Reaching exhaustion end to end
// needs `maxLoops` (3) full Coder round trips, and the fake executor mints ONE job per
// (execution, step) so a re-dispatched Coder re-attaches to the finished job instead of surfacing
// fresh items, the fake's replay-determinism, which is worth more than this one case. The gate
// branch itself is pure state transition over an in-memory instance, so it needs no driver.

const EXHAUSTED = 3

function state(over: Partial<FollowUpsStepState> = {}): FollowUpsStepState {
  return {
    enabled: true,
    loops: EXHAUSTED,
    maxLoops: EXHAUSTED,
    items: [
      {
        id: 'fu_1',
        kind: 'question',
        title: 'Which IngressClass is default?',
        detail: '',
        status: 'answered',
        answer: 'Implement exactly what the task specifies.',
        sentToCoder: false,
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: 'fu_2',
        kind: 'follow_up',
        title: 'Dedupe the retry helper',
        detail: '',
        status: 'queued',
        sentToCoder: false,
        createdAt: 0,
        updatedAt: 0,
      },
      // Already delivered on an earlier pass: it must not be re-counted as dropped.
      {
        id: 'fu_3',
        kind: 'follow_up',
        title: 'Sent last round',
        detail: '',
        status: 'queued',
        sentToCoder: true,
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    ...over,
  }
}

function step(followUps: FollowUpsStepState): PipelineStep {
  return { agentKind: 'coder', state: 'done', followUps } as unknown as PipelineStep
}

function instance(steps: PipelineStep[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    status: 'running',
    currentStep: 0,
    steps,
  } as ExecutionInstance
}

function controller(run?: ExecutionInstance) {
  const logger = createRecordingLogger()
  const increment = vi.fn()
  const persistAndEmit = vi.fn(async () => {})
  const emitInstance = vi.fn(async () => {})
  // The uncontended shape of the real thing: apply the callback and hand back the winner. The
  // contended re-apply is `mutateInstance`'s own contract and is pinned where it lives.
  const mutateInstance = vi.fn(
    async (_ws: string, _id: string, mutate: (i: ExecutionInstance) => void) => {
      mutate(run!)
      return run!
    },
  )
  const gate = new FollowUpGateController({
    blockRepository: { get: async () => ({ id: 'task_1', title: 'Add login' }) },
    executionRepository: { get: async () => null },
    contextBuilder: {},
    stepGraph: { resetStepForRerun: vi.fn(), startStep: vi.fn() },
    runStateMachine: {
      persistAndEmit,
      emitInstance,
      mutateInstance,
      parkStepOnDecision: vi.fn(),
    },
    workRunner: { signalDecision: vi.fn(async () => {}) },
    idGenerator: { next: () => 'fu_x' },
    clock: { now: () => 42 },
    resolveRiskPolicy: async () => ({ autonomy: 'attended' as const }),
    logger,
    operationalMetrics: { increment, gauge: vi.fn(), drain: vi.fn(), drainGauges: vi.fn() },
    // The collaborators above cover every call this branch makes; the rest are unreachable from
    // it and are cast rather than stubbed so an accidental new call fails loudly.
  } as unknown as ConstructorParameters<typeof FollowUpGateController>[0])
  return { gate, logger, increment, persistAndEmit }
}

describe('FollowUpGateController: a spent send-back budget', () => {
  it('stamps the undelivered decisions and lets the run advance', async () => {
    const { gate, persistAndEmit } = controller()
    const followUps = state()
    const run = instance([step(followUps)])

    // `undefined` is "fall through to the ordinary advance": the run is not held, which is the
    // right call, since the budget exists to bound a conversation that is not converging.
    expect(await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)).toBeUndefined()
    // The stamp is COMMITTED here rather than left to ride the caller's eventual write. Between
    // this return and that write sit a terminal resolver, every registered post-op and the
    // PR-report publish, any of which may throw; a report emitted ahead of the row is a drop the
    // re-drive counts twice.
    expect(persistAndEmit).toHaveBeenCalledOnce()

    const byId = new Map(followUps.items.map((i) => [i.id, i]))
    expect(byId.get('fu_1')!.sendBackDropped).toBe(true)
    expect(byId.get('fu_2')!.sendBackDropped).toBe(true)
    // Delivered last round, so nothing was lost with it.
    expect(byId.get('fu_3')!.sendBackDropped).toBeUndefined()
    // The stamp carries the decision's own timestamp: the item changed, and a reader sorting by
    // `updatedAt` should see when.
    expect(byId.get('fu_1')!.updatedAt).toBe(42)
  })

  it('warns once with the budget that ran out, and counts each lost decision', async () => {
    const { gate, logger, increment, persistAndEmit } = controller()
    const run = instance([step(state())])
    // Ordering is the property, not the calls themselves: the row carries the stamp before either
    // signal claims it does.
    const order: string[] = []
    persistAndEmit.mockImplementation(async () => void order.push('persist'))
    increment.mockImplementation(() => void order.push('count'))

    await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)

    expect(order).toEqual(['persist', 'count'])
    const warning = logger.lines.find((l) => l.level === 'warn')
    expect(warning?.msg).toContain('loop budget is spent')
    expect(warning?.fields).toMatchObject({
      runId: 'exec_1',
      blockId: 'task_1',
      dropped: 2,
      loops: EXHAUSTED,
      maxLoops: EXHAUSTED,
    })
    // Per DROPPED DECISION, not per run that dropped any: a triage that queued four items into a
    // spent budget lost four of them, and the rate should read as four.
    expect(increment).toHaveBeenCalledExactlyOnceWith('followup.send_back_dropped', {}, 2)
  })

  it('reports nothing a second time over the same state', async () => {
    // A re-driven advance and a lost CAS race both re-evaluate a step that already dropped. The
    // stamp is what makes that idempotent: re-counting here is the "a periodic read fed to a delta
    // counter re-reports the same rows" mistake, and it would inflate the fleet-wide rate by
    // however many times a run happens to be re-driven.
    const { gate, logger, increment } = controller()
    const followUps = state()
    const run = instance([step(followUps)])

    await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)
    await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)

    expect(increment).toHaveBeenCalledTimes(1)
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(1)
  })

  it('says nothing when the budget is spent with everything already delivered', async () => {
    // The other half of the split: an ordinary finish must not warn, must not count, and must not
    // put a "decisions were dropped" banner on the pull request.
    const { gate, logger, increment } = controller()
    const settled = state({
      items: [
        {
          id: 'fu_1',
          kind: 'question',
          title: 'Which timeout?',
          detail: '',
          status: 'answered',
          answer: '30s',
          sentToCoder: true,
          createdAt: 0,
          updatedAt: 0,
        },
        // A ruling is not an undelivered send-back: it was never going to buy a pass.
        {
          id: 'fu_2',
          kind: 'question',
          title: 'Add pagination?',
          detail: '',
          status: 'closed',
          answer: 'The brief stands.',
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    const run = instance([step(settled)])

    expect(await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)).toBeUndefined()
    expect(increment).not.toHaveBeenCalled()
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(0)
    expect(settled.items.some((i) => i.sendBackDropped)).toBe(false)
  })

  it('says nothing for a step that never had a send-back budget at all', async () => {
    // `followUpLoopBudget` reads a missing ceiling as 0 so the loop STOPS rather than running
    // unbounded, which is the right default for a value that spends model calls and is reachable
    // only for step state persisted before the field existed. Read as an exhausted budget, that
    // same 0 manufactures the alarm: a warn, a counter increment and a pull-request banner about
    // a budget "spent" at 0/0, for a ceiling nobody ever configured. An unwired capability passes
    // through instead.
    const { gate, logger, increment } = controller()
    const unbudgeted = state({ loops: 0, maxLoops: 0 })
    const run = instance([step(unbudgeted)])

    expect(await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)).toBeUndefined()
    expect(increment).not.toHaveBeenCalled()
    expect(logger.lines.filter((l) => l.level === 'warn')).toHaveLength(0)
    expect(unbudgeted.items.some((i) => i.sendBackDropped)).toBe(false)
  })

  it('clears the stamp when the item is decided again, so a drop is never permanent', async () => {
    // Nothing refuses a second decision on an already-decided item, and a person whose queued
    // follow-up was dropped on a spent budget is exactly who re-decides one. The stamp is
    // TERMINAL in `followUpsToSendBack`, so leaving it set would make that item unsendable
    // forever: silently skipped even on a step with budget left, while the window showed "Sent to
    // Coder" beside "never sent to the Coder".
    const followUps = state()
    const run = instance([step(followUps)])
    const { gate } = controller(run)

    await gate.evaluateFollowUpGate('ws_1', run, run.steps[0]!)
    expect(followUps.items.find((i) => i.id === 'fu_2')!.sendBackDropped).toBe(true)

    // A fresh pass is bought (the budget is raised, or the step is re-run) and the human sends it
    // back again.
    followUps.maxLoops = EXHAUSTED + 1
    await gate.queueFollowUp('ws_1', 'exec_1', 'fu_2')

    const item = followUps.items.find((i) => i.id === 'fu_2')!
    expect(item.sendBackDropped).toBeUndefined()
    expect(followUpsToSendBack(followUps).map((i) => i.id)).toContain('fu_2')
  })
})
