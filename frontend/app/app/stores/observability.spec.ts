import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useObservabilityStore } from '~/stores/observability'
import { useWorkspaceStore } from '~/stores/workspace'
import type { LlmCallActivity } from '~/types/execution'

/**
 * The two bounds on a store that would otherwise be a per-session accumulator: live events fold
 * only into runs whose panel was OPENED, and a board switch drops every run. Both are about
 * growth, so both are asserted on what SURVIVES rather than on any one row.
 *
 * There is deliberately NO third bound capping one run's list. That is asserted too, below: the
 * rows a cap would evict are the ones the panel exists to show, so a long watched run keeps all
 * of them.
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

  // A per-run cap was tried here and removed: whatever it evicted, the panel could no longer
  // show, and no eviction rule can tell an operator which call they are now missing. The long
  // watched run is exactly the one worth reading, so it keeps every row.
  it('never evicts a row from an opened run, however long it runs', async () => {
    const store = useObservabilityStore()
    const burst = 1200
    await store.load('exec1')
    for (let i = 0; i < burst; i++) store.appendCall(activity(`c${i}`))

    const held = store.callsFor('exec1')
    expect(held).toHaveLength(burst)
    // Newest-first, and the oldest call is still there to scroll back to.
    expect(held[0]!.id).toBe(`c${burst - 1}`)
    expect(held.at(-1)!.id).toBe('c0')
  })

  it('keeps every row a persisted read answered with when a live call lands on top', async () => {
    const persisted = Array.from({ length: 300 }, (_, i) => ({
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
    expect(store.callsFor('exec1')).toHaveLength(300)

    store.appendCall(activity('live'))
    expect(store.callsFor('exec1')).toHaveLength(301)
    expect(store.callsFor('exec1')[0]!.id).toBe('live')
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
