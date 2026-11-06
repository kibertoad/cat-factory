import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { BrainstormSession } from '~/types/brainstorm'
import { useBrainstormStore } from '~/stores/brainstorm'
import { useWorkspaceStore } from '~/stores/workspace'
import { ApiError } from '~/composables/api/errors'

/** Minimal session factory — only the fields the upsert guard touches. */
function session(over: Partial<BrainstormSession> = {}): BrainstormSession {
  return {
    id: 'bs1',
    blockId: 'b1',
    stage: 'requirements',
    status: 'ready',
    options: [],
    updatedAt: 1000,
    ...over,
  } as BrainstormSession
}

describe('brainstorm store live-event upsert guard', () => {
  it('an out-of-order stream event cannot revert a newer cached session', () => {
    const store = useBrainstormStore()
    store.upsert(session({ updatedAt: 2000, status: 'merged' }))
    store.upsert(session({ updatedAt: 1000, status: 'ready' })) // stale event → ignored
    expect(store.sessionFor('b1', 'requirements')?.status).toBe('merged')
    store.upsert(session({ updatedAt: 3000, status: 'incorporated' }))
    expect(store.sessionFor('b1', 'requirements')?.status).toBe('incorporated')
  })

  it('sessions are keyed per block+stage — one stage cannot clobber another', () => {
    const store = useBrainstormStore()
    store.upsert(session({ updatedAt: 2000 }))
    store.upsert(session({ id: 'bs2', stage: 'architecture', updatedAt: 1000 }))
    expect(store.sessionFor('b1', 'requirements')?.id).toBe('bs1')
    expect(store.sessionFor('b1', 'architecture')?.id).toBe('bs2')
  })
})

describe('brainstorm store load() failures', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('a 503 marks the feature off, not the load failed', async () => {
    vi.stubGlobal('useApi', () => ({
      getBrainstorm: () =>
        Promise.reject(new ApiError(503, { error: { code: 'unavailable', message: 'off' } })),
    }))
    const store = useBrainstormStore()
    await store.load('b1', 'requirements')
    expect(store.available).toBe(false)
    expect(store.loadFailed('b1', 'requirements')).toBe(false)
  })

  it('any other failure marks that stage failed, and a later success clears it', async () => {
    let fail = true
    vi.stubGlobal('useApi', () => ({
      getBrainstorm: () =>
        fail ? Promise.reject(new Error('network down')) : Promise.resolve(session()),
    }))
    const store = useBrainstormStore()
    await store.load('b1', 'requirements')
    expect(store.available).toBeNull()
    expect(store.loadFailed('b1', 'requirements')).toBe(true)
    expect(store.loadFailed('b1', 'architecture')).toBe(false)

    fail = false
    await store.load('b1', 'requirements')
    expect(store.loadFailed('b1', 'requirements')).toBe(false)
    expect(store.sessionFor('b1', 'requirements')?.id).toBe('bs1')
  })
})
