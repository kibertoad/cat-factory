import { describe, expect, it, vi } from 'vitest'
import { useGuidedReviewStore } from '~/stores/guidedReview'
import { useWorkspaceStore } from '~/stores/workspace'

function view(sessionId: string, title: string) {
  return {
    session: { id: sessionId, prTitle: title },
    threads: [],
    drafts: [],
  } as never
}

function threadView(threadId: string, messages: number) {
  return {
    thread: { id: threadId, sessionId: 's1' },
    messages: Array.from({ length: messages }, (_, i) => ({ id: `m${i}` })),
  } as never
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

describe('guided review store', () => {
  it('refetches only what this client has loaded when a change arrives', async () => {
    const getGuidedReview = vi.fn(async (_ws: string, id: string) => view(id, 'fresh'))
    const getGuidedReviewThread = vi.fn(async () => threadView('t1', 2))
    vi.stubGlobal('useApi', () => ({ getGuidedReview, getGuidedReviewThread }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()

    await store.applyChange({ sessionId: 'elsewhere', scope: 'thread', threadId: 't9' })
    expect(getGuidedReview).not.toHaveBeenCalled()
    expect(getGuidedReviewThread).not.toHaveBeenCalled()

    await store.loadSession('s1')
    await store.loadThread('s1', 't1')
    getGuidedReview.mockClear()
    getGuidedReviewThread.mockClear()
    await store.applyChange({ sessionId: 's1', scope: 'thread', threadId: 't1' })
    expect(getGuidedReview).toHaveBeenCalledTimes(1)
    expect(getGuidedReviewThread).toHaveBeenCalledTimes(1)
  })

  it('drops a slow reply that a newer fetch overtook', async () => {
    const slow = deferred<never>()
    const replies = [slow.promise, Promise.resolve(view('s1', 'newer'))]
    vi.stubGlobal('useApi', () => ({ getGuidedReview: vi.fn(() => replies.shift()) }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()

    const first = store.loadSession('s1')
    await store.loadSession('s1')
    slow.resolve(view('s1', 'stale'))
    await first
    expect(store.sessions.s1?.session.prTitle).toBe('newer')
  })

  it('forgets a deleted session and its threads', async () => {
    vi.stubGlobal('useApi', () => ({
      getGuidedReview: vi.fn(async () => view('s1', 'x')),
      getGuidedReviewThread: vi.fn(async () => threadView('t1', 1)),
    }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.loadThread('s1', 't1')
    await store.applyChange({ sessionId: 's1', scope: 'deleted' })
    expect(store.sessions.s1).toBeUndefined()
    expect(store.threads.t1).toBeUndefined()
  })
})
