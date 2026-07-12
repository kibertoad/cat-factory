import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDocInterviewStore } from '~/stores/docInterview'
import { useWorkspaceStore } from '~/stores/workspace'
import type { DocInterviewSession } from '~/types/domain'

/** Minimal session factory — only the fields the store reconciles/reads. */
function session(over: Partial<DocInterviewSession> = {}): DocInterviewSession {
  return {
    id: 'd1',
    blockId: 'blk1',
    status: 'awaiting_answers',
    round: 1,
    maxRounds: 3,
    qa: [],
    brief: null,
    model: null,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  } as DocInterviewSession
}

// docInterview already routes its `load` through `upsert`'s newest-wins (`updatedAt`) guard —
// these specs pin that so a future refactor can't reintroduce a blind-replace clobber.
describe('docInterview store — load vs live-push reconcile', () => {
  beforeEach(() => {
    useWorkspaceStore().workspaceId = 'ws1'
  })

  it('load stores the fetched session', async () => {
    vi.stubGlobal('useApi', () => ({
      getDocInterview: () => Promise.resolve(session()),
    }))
    const store = useDocInterviewStore()
    await store.load('blk1')
    expect(store.forBlock('blk1')?.id).toBe('d1')
  })

  it('a stale load never regresses a fresher live-pushed session', async () => {
    let resolveFetch!: (r: DocInterviewSession | null) => void
    const pending = new Promise<DocInterviewSession | null>((res) => {
      resolveFetch = res
    })
    vi.stubGlobal('useApi', () => ({ getDocInterview: () => pending }))
    const store = useDocInterviewStore()

    const load = store.load('blk1')
    store.upsert(session({ updatedAt: 10, round: 2 }))
    resolveFetch(session({ updatedAt: 2, round: 1 }))
    await load

    expect(store.forBlock('blk1')?.round).toBe(2)
  })

  it('a load returning "none" leaves the cache untouched', async () => {
    vi.stubGlobal('useApi', () => ({
      getDocInterview: () => Promise.resolve(null),
    }))
    const store = useDocInterviewStore()
    store.upsert(session({ round: 2 }))
    await store.load('blk1')
    expect(store.forBlock('blk1')?.round).toBe(2)
  })
})
