import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '~/composables/api/errors'
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

  it('lets a refresh win over a load that started before it', async () => {
    const slow = deferred<never>()
    vi.stubGlobal('useApi', () => ({
      getGuidedReview: vi.fn(() => slow.promise),
      refreshGuidedReview: vi.fn(async () => view('s1', 'refreshed')),
    }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()

    const load = store.loadSession('s1')
    await store.refresh('s1')
    slow.resolve(view('s1', 'stale'))
    await load
    expect(store.sessions.s1?.session.prTitle).toBe('refreshed')
  })

  it('does not bring back a deleted session through a load still in flight', async () => {
    const slow = deferred<never>()
    vi.stubGlobal('useApi', () => ({ getGuidedReview: vi.fn(() => slow.promise) }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()

    const load = store.loadSession('s1')
    await store.applyChange({ sessionId: 's1', scope: 'deleted' })
    slow.resolve(view('s1', 'stale'))
    await load
    expect(store.sessions.s1).toBeUndefined()
  })

  it('refetches the thread a drafts change names', async () => {
    const getGuidedReview = vi.fn(async (_ws: string, id: string) => view(id, 'x'))
    const getGuidedReviewThread = vi.fn(async () => threadView('t1', 3))
    vi.stubGlobal('useApi', () => ({ getGuidedReview, getGuidedReviewThread }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.loadThread('s1', 't1')
    getGuidedReviewThread.mockClear()
    await store.applyChange({ sessionId: 's1', scope: 'drafts', threadId: 't1' })
    expect(getGuidedReviewThread).toHaveBeenCalledTimes(1)
  })

  it('records a failed background refetch and clears it when the session lands again', async () => {
    const failure = new ApiError(503, { error: { code: 'unavailable' } })
    const getGuidedReview = vi
      .fn()
      .mockResolvedValueOnce(view('s1', 'x'))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(view('s1', 'y'))
    vi.stubGlobal('useApi', () => ({ getGuidedReview }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.applyChange({ sessionId: 's1', scope: 'session' })
    expect(store.sessions.s1?.session.prTitle).toBe('x')
    expect(store.refetchFailures.s1).toBe(failure)
    await store.applyChange({ sessionId: 's1', scope: 'session' })
    expect(store.refetchFailures.s1).toBeUndefined()
  })

  it('keeps a failed session refetch recorded while one of its threads lands', async () => {
    const failure = new ApiError(503, { error: { code: 'unavailable' } })
    const getGuidedReview = vi
      .fn()
      .mockResolvedValueOnce(view('s1', 'x'))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(view('s1', 'y'))
    const getGuidedReviewThread = vi.fn(async () => threadView('t1', 2))
    vi.stubGlobal('useApi', () => ({ getGuidedReview, getGuidedReviewThread }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.applyChange({ sessionId: 's1', scope: 'session' })
    expect(store.refetchFailures.s1).toBe(failure)
    // The session view is still the stale one, so the warning must stay.
    await store.loadThread('s1', 't1')
    expect(store.refetchFailures.s1).toBe(failure)
    await store.loadSession('s1')
    expect(store.refetchFailures.s1).toBeUndefined()
  })

  it('clears a failed thread refetch when that thread lands again', async () => {
    const failure = new ApiError(503, { error: { code: 'unavailable' } })
    const getGuidedReview = vi.fn(async (_ws: string, id: string) => view(id, 'x'))
    const getGuidedReviewThread = vi
      .fn()
      .mockResolvedValueOnce(threadView('t1', 1))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(threadView('t1', 2))
    vi.stubGlobal('useApi', () => ({ getGuidedReview, getGuidedReviewThread }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.loadThread('s1', 't1')
    await store.applyChange({ sessionId: 's1', scope: 'thread', threadId: 't1' })
    expect(store.refetchFailures.s1).toBe(failure)
    await store.loadThread('s1', 't1')
    expect(store.refetchFailures.s1).toBeUndefined()
  })

  it('drops the failure of a background refetch that a newer fetch overtook', async () => {
    let rejectSlow!: (error: unknown) => void
    const slow = new Promise<never>((_, reject) => (rejectSlow = reject))
    const replies = [Promise.resolve(view('s1', 'x')), slow, Promise.resolve(view('s1', 'newer'))]
    vi.stubGlobal('useApi', () => ({ getGuidedReview: vi.fn(() => replies.shift()) }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')

    const background = store.applyChange({ sessionId: 's1', scope: 'session' })
    await store.loadSession('s1')
    rejectSlow(new ApiError(503, { error: { code: 'unavailable' } }))
    await background
    expect(store.sessions.s1?.session.prTitle).toBe('newer')
    expect(store.refetchFailures.s1).toBeUndefined()
  })

  it('reloads the threads whose refetch failed on an explicit refresh', async () => {
    const failure = new ApiError(503, { error: { code: 'unavailable' } })
    const getGuidedReview = vi.fn(async (_ws: string, id: string) => view(id, 'x'))
    const refreshGuidedReview = vi.fn(async () => view('s1', 'refreshed'))
    const getGuidedReviewThread = vi
      .fn()
      .mockResolvedValueOnce(threadView('t1', 1))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(threadView('t1', 2))
    vi.stubGlobal('useApi', () => ({
      getGuidedReview,
      refreshGuidedReview,
      getGuidedReviewThread,
    }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.loadThread('s1', 't1')
    await store.applyChange({ sessionId: 's1', scope: 'thread', threadId: 't1' })
    expect(store.refetchFailures.s1).toBe(failure)

    await store.refresh('s1')
    expect(getGuidedReviewThread).toHaveBeenCalledTimes(3)
    expect(store.threads.t1?.messages).toHaveLength(2)
    expect(store.refetchFailures.s1).toBeUndefined()
  })

  it('forgets a session whose refetch answers 404', async () => {
    const getGuidedReview = vi
      .fn()
      .mockResolvedValueOnce(view('s1', 'x'))
      .mockRejectedValueOnce(new ApiError(404, { error: { code: 'not_found' } }))
    vi.stubGlobal('useApi', () => ({ getGuidedReview }))
    useWorkspaceStore().workspaceId = 'ws_1'
    const store = useGuidedReviewStore()
    await store.loadSession('s1')
    await store.applyChange({ sessionId: 's1', scope: 'session' })
    expect(store.sessions.s1).toBeUndefined()
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
