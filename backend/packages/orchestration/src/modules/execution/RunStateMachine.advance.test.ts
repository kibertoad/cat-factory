import type {
  Block,
  BlockPatch,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
  ExecutionRepository,
  PipelineStep,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import { RunStateMachine } from './RunStateMachine.js'

// What a run advancing past a settled step may do to the block's STATUS.
//
// The rule reads as bookkeeping and is not: a merged task's `done` is set mid-pipeline by the
// merger's resolver, and every step after it settles claiming nothing. `resolverOwnsTerminalStatus`
// answers only for the step settling right now, so relying on it alone holds while the claiming
// step is the last one and breaks one step further along — `merger → assessor → disposer` writes
// `in_progress` over a real merge, and `finalizeBlock`'s merger backstop then rewrites the task as
// `pr_ready`. These pin the block's own status as the record of the claim.

function step(agentKind: string): PipelineStep {
  return { agentKind, state: 'pending', progress: 0 } as unknown as PipelineStep
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

function makeMachine(status: Block['status']) {
  const patches: BlockPatch[] = []
  const block = { id: 'task_login', title: 'Add passkey login', status } as unknown as Block
  const blockRepository: BlockRepository = {
    get: async () => block,
    update: async (_ws: string, _id: string, patch: BlockPatch) => {
      patches.push(patch)
    },
  } as unknown as BlockRepository
  const executionRepository: ExecutionRepository = {
    compareAndSwap: async () => true,
  } as unknown as ExecutionRepository
  const stepGraph = {
    startStep: (s: PipelineStep) => {
      s.state = 'working'
    },
  }
  const machine = new RunStateMachine({
    executionRepository,
    blockRepository,
    events: { executionChanged: async () => {} } as unknown as ExecutionEventPublisher,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: { now: () => 1_700_000_000_000 },
    stepGraph: stepGraph as never,
  })
  return { machine, patches }
}

describe('RunStateMachine.settleStepAndAdvance — the block status a trailing step may not take back', () => {
  it('keeps a merged task `done` when a step that claims nothing settles after the merger', async () => {
    // The shape the assessment kind introduced: `merger → task-reassessor → disposer`. The merger
    // claimed `done` one step ago, so the claim is no longer on the settling resolver's result.
    const { machine, patches } = makeMachine('done')
    const instance = makeInstance([step('merger'), step('task-reassessor'), step('disposer')], 1)
    instance.steps[0]!.state = 'done'
    instance.steps[1]!.state = 'done'

    const result = await machine.settleStepAndAdvance('ws_1', instance, /* isFinalStep */ false, {})

    expect(result).toEqual({ kind: 'continue' })
    // Progress moves; the status is untouched, so nothing downstream can read a downgraded row.
    expect(patches).toEqual([{ progress: 2 / 3 }])
  })

  it('keeps a `pr_ready` task there too', async () => {
    // The merger's other outcome: it raised a merge review rather than merging. Downgrading that
    // to `in_progress` mid-run makes the board claim the review is no longer waiting on anyone.
    const { machine, patches } = makeMachine('pr_ready')
    const instance = makeInstance([step('merger'), step('task-reassessor')], 0)
    instance.steps[0]!.state = 'done'

    await machine.settleStepAndAdvance('ws_1', instance, false, {})

    expect(patches).toEqual([{ progress: 1 / 2 }])
  })

  it('still writes `in_progress` while the run is genuinely mid-flight', async () => {
    // The ordinary case, and the reason the status write exists: a run advancing between producers
    // has to move the block out of whatever it was before the run started.
    const { machine, patches } = makeMachine('in_progress')
    const instance = makeInstance([step('coder'), step('reviewer')], 0)
    instance.steps[0]!.state = 'done'

    await machine.settleStepAndAdvance('ws_1', instance, false, {})

    expect(patches).toEqual([{ status: 'in_progress', progress: 1 / 2 }])
  })
})
