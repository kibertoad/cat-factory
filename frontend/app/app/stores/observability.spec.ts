import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useObservabilityStore } from '~/stores/observability'
import { useWorkspaceStore } from '~/stores/workspace'
import type { LlmCallActivity } from '~/types/execution'

/**
 * The two bounds on a store that is otherwise a per-session accumulator: the per-run cap on
 * live-appended rows, and the board-switch eviction. Both are about growth, so both are asserted
 * on what SURVIVES rather than on any one row.
 */

/** A live `llmCall` event carrying only what `appendCall` materialises a row from. */
function activity(id: string, executionId = 'exec1'): LlmCallActivity {
  return {
    id,
    executionId,
    blockId: 'blk1',
    agentKind: 'coder',
    model: 'm',
    ok: true,
    phase: 'agent',
    finishReason: 'stop',
  } as unknown as LlmCallActivity
}

describe('observability store growth bounds', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
    vi.stubGlobal('useApi', () => ({
      getLlmMetrics: () => Promise.resolve({ calls: [] }),
    }))
  })

  it('folds live calls only into runs whose panel has been opened', async () => {
    const store = useObservabilityStore()
    store.appendCall(activity('never-opened'))
    expect(store.callsFor('exec1')).toEqual([])

    await store.load('exec1')
    store.appendCall(activity('c1'))
    expect(store.callsFor('exec1').map((c) => c.id)).toEqual(['c1'])
  })

  it('caps the live list of an opened run and says how many rows it dropped', async () => {
    const store = useObservabilityStore()
    await store.load('exec1')
    for (let i = 0; i < 520; i++) store.appendCall(activity(`c${i}`))

    const held = store.callsFor('exec1')
    expect(held).toHaveLength(500)
    // Newest-first, so the cap takes the OLDEST: the most recent call is still at the front.
    expect(held[0]!.id).toBe('c519')
    expect(store.droppedLiveCallCount('exec1')).toBe(20)
  })

  it('stops claiming rows were dropped once the persisted read replaces the list', async () => {
    const store = useObservabilityStore()
    await store.load('exec1')
    for (let i = 0; i < 520; i++) store.appendCall(activity(`c${i}`))
    expect(store.droppedLiveCallCount('exec1')).toBe(20)

    await store.load('exec1')
    expect(store.droppedLiveCallCount('exec1')).toBe(0)
  })

  it('evicts every per-run cache on a board switch', async () => {
    const store = useObservabilityStore()
    await store.load('exec1')
    store.appendCall(activity('c1'))
    expect(store.callsFor('exec1')).toHaveLength(1)

    store.reset()
    // Back to "never opened": the run is gone, so a stray live event for it folds nowhere.
    store.appendCall(activity('c2'))
    expect(store.callsFor('exec1')).toEqual([])
    expect(store.callsByExecution).toEqual({})
  })
})
