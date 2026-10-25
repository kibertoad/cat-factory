import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useConsensusStore } from '~/stores/consensus'
import { useWorkspaceStore } from '~/stores/workspace'
import type { ConsensusSession } from '~/types/consensus'
import { ApiError } from '~/composables/api/errors'

/** Minimal session factory — only the fields the store reconciles/reads. */
function session(over: Partial<ConsensusSession> = {}): ConsensusSession {
  return {
    id: 's1',
    blockId: 'blk1',
    executionId: null,
    stepIndex: 0,
    agentKind: 'architect',
    strategy: 'panel',
    status: 'complete',
    participants: [],
    rounds: [],
    synthesis: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as ConsensusSession
}

describe('consensus store — load vs live-push reconcile', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the fetched session', async () => {
    vi.stubGlobal('useApi', () => ({
      getConsensusSession: () => Promise.resolve({ session: session() }),
    }))
    const store = useConsensusStore()
    await store.load('blk1')
    expect(store.sessionFor('blk1')?.id).toBe('s1')
  })

  it('a stale load never regresses a fresher live-pushed session', async () => {
    // A live `consensus` push delivers the newest transcript; a `load` that started earlier
    // resolves later with a staler snapshot. It must NOT overwrite the fresher one.
    let resolveFetch!: (r: { session: ConsensusSession | null }) => void
    const pending = new Promise<{ session: ConsensusSession | null }>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({ getConsensusSession: () => pending }))
    const store = useConsensusStore()

    const load = store.load('blk1')
    store.upsert(session({ updatedAt: 10, synthesis: 'fresh' }))
    resolveFetch({ session: session({ updatedAt: 2, synthesis: 'stale' }) })
    await load

    expect(store.sessionFor('blk1')?.synthesis).toBe('fresh')
  })

  it('a load returning "none" never clobbers an existing live session', async () => {
    vi.stubGlobal('useApi', () => ({
      getConsensusSession: () => Promise.resolve({ session: null }),
    }))
    const store = useConsensusStore()
    store.upsert(session({ synthesis: 'live' }))
    await store.load('blk1')
    expect(store.sessionFor('blk1')?.synthesis).toBe('live')
  })

  it('a load returning "none" records the fetched-empty state when nothing is cached', async () => {
    vi.stubGlobal('useApi', () => ({
      getConsensusSession: () => Promise.resolve({ session: null }),
    }))
    const store = useConsensusStore()
    await store.load('blk1')
    expect('blk1' in store.sessions).toBe(true)
    expect(store.sessionFor('blk1')).toBeNull()
  })

  it('a 503 (consensus off) reads as no session, not as a failed load', async () => {
    vi.stubGlobal('useApi', () => ({
      getConsensusSession: () =>
        Promise.reject(new ApiError(503, { error: { code: 'unavailable', message: 'off' } })),
    }))
    const store = useConsensusStore()
    await store.load('blk1')
    expect(store.loadFailed('blk1')).toBe(false)
    expect('blk1' in store.sessions).toBe(true)
    expect(store.sessionFor('blk1')).toBeNull()
  })

  it('any other failure is recorded as a failed load, and a later success clears it', async () => {
    let fail = true
    vi.stubGlobal('useApi', () => ({
      getConsensusSession: () =>
        fail
          ? Promise.reject(new ApiError(500, { error: { code: 'internal', message: 'boom' } }))
          : Promise.resolve({ session: session() }),
    }))
    const store = useConsensusStore()
    await store.load('blk1')
    expect(store.loadFailed('blk1')).toBe(true)
    expect('blk1' in store.sessions).toBe(false)

    fail = false
    await store.load('blk1')
    expect(store.loadFailed('blk1')).toBe(false)
    expect(store.sessionFor('blk1')?.id).toBe('s1')
  })
})
