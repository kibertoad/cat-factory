import type { Block, BlockRepository, ExecutionInstance, Notification } from '@cat-factory/kernel'
import { describe, expect, it } from 'vitest'
import type { NotificationService } from '../notifications/NotificationService.js'
import { RunStateMachine } from './RunStateMachine.js'

// F7 (stuck-run audit): `ensureWaitingNotification` is the ONLY recovery signal for a run parked
// `blocked` on a human decision (the sweeper never touches `blocked`). Its non-clobbering guard
// used to suppress on ANY open card on the block, so a STALE card left by a PRIOR run masked the
// signal for the new park — dismiss that unrelated card and the parked run was silently stuck.
// The guard is now scoped to THIS run's `executionId`: a richer card for the same run still wins,
// but a prior run's card no longer suppresses.

function makeInstance(executionId: string, blockId = 'task_y'): ExecutionInstance {
  return {
    id: executionId,
    blockId,
    pipelineId: 'pl_1',
    pipelineName: 'Build',
    steps: [],
    currentStep: 0,
    status: 'blocked',
  }
}

function card(overrides: Partial<Notification>): Notification {
  return {
    id: 'ntf_x',
    type: 'merge_review',
    status: 'open',
    severity: 'normal',
    blockId: 'task_y',
    executionId: null,
    title: 't',
    body: 'b',
    payload: null,
    createdAt: 1,
    resolvedAt: null,
    ...overrides,
  }
}

function makeMachine(open: Notification[]) {
  const raised: { type: string; blockId: string | null; executionId: string | null }[] = []
  const resolved: { id: string; action: string }[] = []
  const notificationService = {
    listOpen: async () => open,
    raise: async (
      _ws: string,
      input: { type: string; blockId: string | null; executionId: string | null },
    ) => {
      raised.push({ type: input.type, blockId: input.blockId, executionId: input.executionId })
      return card(input as Partial<Notification>)
    },
    resolve: async (_ws: string, id: string, action: string) => {
      resolved.push({ id, action })
      return card({ id })
    },
  } as unknown as NotificationService
  const blockRepository: BlockRepository = {
    get: async () => ({ id: 'task_y', title: 'Auth' }) as unknown as Block,
  } as unknown as BlockRepository
  const machine = new RunStateMachine({
    executionRepository: {} as never,
    blockRepository,
    events: {} as never,
    workRunner: {} as never,
    agentExecutor: {} as never,
    idGenerator: {} as never,
    clock: {} as never,
    stepGraph: {} as never,
    notificationService,
  })
  return { machine, raised, resolved }
}

describe('RunStateMachine.ensureWaitingNotification — F7 executionId-scoped suppression', () => {
  it('raises a decision_required card when the block has no open notification', async () => {
    const { machine, raised } = makeMachine([])
    await machine.ensureWaitingNotification('ws_1', makeInstance('exec_now'))
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ type: 'decision_required', executionId: 'exec_now' })
  })

  it('does NOT raise when a card for THIS run already sits on the block (richer card wins)', async () => {
    const { machine, raised } = makeMachine([
      card({ id: 'ntf_this', type: 'merge_review', executionId: 'exec_now' }),
    ])
    await machine.ensureWaitingNotification('ws_1', makeInstance('exec_now'))
    expect(raised).toHaveLength(0)
  })

  it('STILL raises when only a stale card from a PRIOR run sits on the block', async () => {
    // The prior run's terminal `pipeline_complete` card must not stand in for the new park.
    const { machine, raised } = makeMachine([
      card({ id: 'ntf_stale', type: 'pipeline_complete', executionId: 'exec_prior' }),
    ])
    await machine.ensureWaitingNotification('ws_1', makeInstance('exec_now'))
    expect(raised).toHaveLength(1)
    expect(raised[0]).toMatchObject({ type: 'decision_required', executionId: 'exec_now' })
  })

  it('STILL raises when a block-less workspace card is open (not scoped to this block/run)', async () => {
    const { machine, raised } = makeMachine([
      card({ id: 'ntf_ws', type: 'budget_paused', blockId: null, executionId: null }),
    ])
    await machine.ensureWaitingNotification('ws_1', makeInstance('exec_now'))
    expect(raised).toHaveLength(1)
  })
})

// F3 (stuck-run audit): a spend-`paused` run is invisible to the sweeper and has no auto-resume,
// so the paused board badge used to be its only signal. `raiseBudgetPaused` surfaces ONE
// workspace-scoped inbox card (de-duplicated, since a block-less card has no per-type unique
// index); `clearBudgetPaused` dismisses it when the pause is lifted.
describe('RunStateMachine budget_paused card (F3)', () => {
  it('raises a workspace-scoped budget_paused card when none is open', async () => {
    const { machine, raised } = makeMachine([])
    await machine.raiseBudgetPaused('ws_1')
    expect(raised).toEqual([{ type: 'budget_paused', blockId: null, executionId: null }])
  })

  it('does NOT raise a second card when one is already open (one per workspace, not per run)', async () => {
    const { machine, raised } = makeMachine([
      card({ id: 'ntf_budget', type: 'budget_paused', blockId: null, executionId: null }),
    ])
    await machine.raiseBudgetPaused('ws_1')
    expect(raised).toHaveLength(0)
  })

  it('clearBudgetPaused dismisses the open card', async () => {
    const { machine, resolved } = makeMachine([
      card({ id: 'ntf_budget', type: 'budget_paused', blockId: null, executionId: null }),
      card({ id: 'ntf_other', type: 'merge_review', executionId: 'exec_x' }),
    ])
    await machine.clearBudgetPaused('ws_1')
    // Only the budget card is dismissed — the unrelated merge_review is left for the human.
    expect(resolved).toEqual([{ id: 'ntf_budget', action: 'dismiss' }])
  })
})
