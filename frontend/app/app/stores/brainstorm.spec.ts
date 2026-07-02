import { describe, it, expect } from 'vitest'
import type { BrainstormSession } from '~/types/brainstorm'
import { useBrainstormStore } from '~/stores/brainstorm'

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
