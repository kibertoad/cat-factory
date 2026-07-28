import type {
  Block,
  BlockRepository,
  ExecutionEventPublisher,
  ExecutionInstance,
} from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { NotificationService } from '../notifications/NotificationService.js'
import { RunStateMachine } from './RunStateMachine.js'

// finalizeBlock decides a finished run's terminal block status. The no-PR terminal path is the
// one the read-only pipelines (PR deep-review, spike, bare analysis) rely on: a pipeline with no
// merger AND no PR opened has nothing to merge, so the block is simply `done` — NOT `pr_ready`
// with a `pipeline_complete` card, which assumes a PR to confirm/merge. These tests pin that
// fork so a read-only pipeline finishes cleanly and a PR-producing one still asks for confirm.

function makeMachine(block: Block, onRaise?: () => void) {
  const updates: { id: string; patch: Record<string, unknown> }[] = []
  const raised: { type: string }[] = []
  /** Interleaved log of both side effects, so a test can pin their ORDER (see F11). */
  const order: string[] = []
  const blockRepository: BlockRepository = {
    get: async () => block,
    update: async (_ws: string, id: string, patch: Record<string, unknown>) => {
      order.push('update')
      updates.push({ id, patch })
    },
  } as unknown as BlockRepository
  const events: ExecutionEventPublisher = {
    executionChanged: async () => {},
  } as unknown as ExecutionEventPublisher
  const notificationService = {
    raise: async (_ws: string, n: { type: string }) => {
      order.push('raise')
      onRaise?.()
      raised.push({ type: n.type })
    },
  } as unknown as NotificationService
  const machine = new RunStateMachine({
    executionRepository: {} as never,
    blockRepository,
    events,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: {} as never,
    stepGraph: {} as never,
    notificationService,
  })
  return { machine, updates, raised, order }
}

function instanceWith(kinds: string[]): ExecutionInstance {
  return {
    id: 'exec_1',
    blockId: 'task_1',
    pipelineId: 'pl_review',
    pipelineName: 'Review a pull request',
    steps: kinds.map((agentKind) => ({ agentKind, state: 'done', progress: 1 })),
    currentStep: kinds.length,
    status: 'running',
  } as unknown as ExecutionInstance
}

describe('RunStateMachine.finalizeBlock — no-PR terminal path', () => {
  it('marks a read-only review pipeline (no merger, no PR) done with no pipeline_complete card', async () => {
    const block = { id: 'task_1', level: 'task', status: 'in_progress' } as unknown as Block
    const { machine, updates, raised } = makeMachine(block)

    await machine.finalizeBlock('ws_1', instanceWith(['pr-reviewer']), undefined)

    expect(updates).toEqual([{ id: 'task_1', patch: { status: 'done', progress: 1 } }])
    expect(raised).toHaveLength(0)
  })

  it('still marks a PR-producing no-merger pipeline pr_ready and raises pipeline_complete', async () => {
    const block = {
      id: 'task_1',
      level: 'task',
      status: 'in_progress',
      pullRequest: { branch: 'feat/x', url: 'https://example.test/pr/1' },
    } as unknown as Block
    const { machine, updates, raised } = makeMachine(block)

    await machine.finalizeBlock('ws_1', instanceWith(['coder']), undefined)

    expect(updates).toEqual([{ id: 'task_1', patch: { status: 'pr_ready', progress: 1 } }])
    expect(raised).toEqual([{ type: 'pipeline_complete' }])
  })

  it('raises pipeline_complete BEFORE flipping the block, and leaves it alone if the raise fails', async () => {
    // F11: the card is the only actionable prompt for a confirm-and-merge, and nothing re-drives
    // a settled run. Flipping first meant a raise failure left a `pr_ready` block that looks
    // finished-and-waiting with an empty inbox; raising first makes the surviving state the
    // honest one (the run fails, the block keeps its prior status).
    const prBlock = () =>
      ({
        id: 'task_1',
        level: 'task',
        status: 'in_progress',
        pullRequest: { branch: 'feat/x', url: 'https://example.test/pr/1' },
      }) as unknown as Block

    const ordered = makeMachine(prBlock())
    await ordered.machine.finalizeBlock('ws_1', instanceWith(['coder']), undefined)
    expect(ordered.order).toEqual(['raise', 'update'])

    const failing = makeMachine(prBlock(), () => {
      throw new Error('notification store down')
    })
    await expect(
      failing.machine.finalizeBlock('ws_1', instanceWith(['coder']), undefined),
    ).rejects.toThrow('notification store down')
    expect(failing.updates).toEqual([])
  })
})
