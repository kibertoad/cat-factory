import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LLM_CALL_LIST_LIMIT } from '@cat-factory/contracts'
import { useObservabilityStore } from '~/stores/observability'
import { useWorkspaceStore } from '~/stores/workspace'
import type { LlmCallActivity } from '~/types/execution'

/**
 * The two bounds on a store that is otherwise a per-session accumulator: the per-run cap on a
 * run's call list, and the board-switch eviction. Both are about growth, so both are asserted on
 * what SURVIVES rather than on any one row.
 *
 * The cap is DERIVED from `LLM_CALL_LIST_LIMIT` rather than re-pinned here: the number is the
 * server's own read bound and the whole point of sharing it is that the two cannot drift, so a
 * test that hard-coded it would pass while the store held a different window than the endpoint.
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
    const over = 20
    await store.load('exec1')
    for (let i = 0; i < LLM_CALL_LIST_LIMIT + over; i++) store.appendCall(activity(`c${i}`))

    const held = store.callsFor('exec1')
    expect(held).toHaveLength(LLM_CALL_LIST_LIMIT)
    // Newest-first, so the cap takes the OLDEST: the most recent call is still at the front.
    expect(held[0]!.id).toBe(`c${LLM_CALL_LIST_LIMIT + over - 1}`)
    expect(store.droppedCallCount('exec1')).toBe(over)
  })

  it('stops claiming rows were dropped once the persisted read replaces the list', async () => {
    const store = useObservabilityStore()
    await store.load('exec1')
    for (let i = 0; i < LLM_CALL_LIST_LIMIT + 20; i++) store.appendCall(activity(`c${i}`))
    expect(store.droppedCallCount('exec1')).toBe(20)

    await store.load('exec1')
    expect(store.droppedCallCount('exec1')).toBe(0)
  })

  // The cap is the SERVER's read bound, and this is why. Sized below it, the first live event on
  // a run whose persisted log fills the read would evict rows the server did answer with and
  // report them as dropped: a count of calls the panel is missing for a reason that never
  // happened, on the run most worth reading.
  it('keeps every row a full persisted read answered with when a live call lands on top', async () => {
    const persisted = Array.from({ length: LLM_CALL_LIST_LIMIT }, (_, i) => ({
      ...activity(`p${i}`),
      turnIndex: null,
      promptText: '',
      promptPrefixCount: 0,
      promptHash: '',
      responseText: '',
      reasoningText: '',
    }))
    vi.stubGlobal('useApi', () => ({
      getLlmMetrics: () => Promise.resolve({ calls: persisted }),
    }))
    const store = useObservabilityStore()
    await store.load('exec1')
    expect(store.callsFor('exec1')).toHaveLength(LLM_CALL_LIST_LIMIT)
    expect(store.droppedCallCount('exec1')).toBe(0)

    store.appendCall(activity('live'))
    // One in, one out, and the count says one — not the hundreds a smaller cap would have cut.
    expect(store.callsFor('exec1')).toHaveLength(LLM_CALL_LIST_LIMIT)
    expect(store.callsFor('exec1')[0]!.id).toBe('live')
    expect(store.droppedCallCount('exec1')).toBe(1)
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
