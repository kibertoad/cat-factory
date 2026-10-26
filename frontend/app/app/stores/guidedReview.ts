import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AskGuidedReviewInput,
  EditGuidedReviewDraftInput,
  GuidedReviewCommentDraft,
  GuidedReviewPostResult,
  GuidedReviewChange,
  GuidedReviewSessionView,
  GuidedReviewThreadView,
  OpenGuidedReviewInput,
  OpenGuidedReviewThreadInput,
} from '~/types/domain'
import { ApiError } from '~/composables/api/errors'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Guided PR review sessions and the threads a window has opened, loaded on demand and kept live
 * by `guidedReview` stream events. An event carries ids only, so `applyChange` refetches what is
 * loaded here and ignores the rest. Every fetch and every write takes a ticket, and a fetch lands
 * only while its ticket is the newest for its key, so a change that arrives mid-fetch is never
 * lost to a stale reply and a forgotten session is never brought back by one.
 */
export const useGuidedReviewStore = defineStore('guidedReview', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const sessions = ref<Record<string, GuidedReviewSessionView>>({})
  const threads = ref<Record<string, GuidedReviewThreadView>>({})
  /**
   * The errors of failed background refetches: per session, per fetch key (the session itself or
   * one of its threads). A key's entry clears when that key lands again, so a thread landing says
   * nothing about a failed session load, and the other way round.
   */
  const failedLoads = ref<Record<string, Record<string, unknown>>>({})
  /**
   * Per session, the error of a load that is still failing, so a window can say its view may be
   * out of date. Present while any of the session's failed loads has not landed again.
   */
  const refetchFailures = computed(() => {
    const out: Record<string, unknown> = {}
    for (const [sessionId, byKey] of Object.entries(failedLoads.value)) {
      const errors = Object.values(byKey)
      if (errors.length) out[sessionId] = errors.at(-1)
    }
    return out
  })
  // One counter for every key and never reset, so a key dropped by `forget` or `reset` is never
  // landed on by a fetch that was in flight when it went.
  let issued = 0
  const newest = new Map<string, number>()

  const sessionKey = (sessionId: string) => `s:${sessionId}`
  const threadKey = (sessionId: string, threadId: string) => `t:${sessionId}:${threadId}`

  function claim(key: string): number {
    issued += 1
    newest.set(key, issued)
    return issued
  }

  /**
   * Run `fetch` for `key`, landing its result only if no newer fetch or write for it started. A
   * superseded fetch neither lands nor fails: its error is dropped, so it cannot report a view
   * that a newer fetch has already brought up to date as out of date.
   */
  async function latest<T>(key: string, fetch: () => Promise<T>, land: (value: T) => void) {
    const ticket = claim(key)
    let value: T
    try {
      value = await fetch()
    } catch (error) {
      if (newest.get(key) === ticket) throw error
      return
    }
    if (newest.get(key) === ticket) land(value)
  }

  function recordFailure(sessionId: string, key: string, error: unknown) {
    failedLoads.value[sessionId] = { ...failedLoads.value[sessionId], [key]: error }
  }

  function clearFailure(sessionId: string, key: string) {
    const byKey = failedLoads.value[sessionId]
    if (!byKey || !(key in byKey)) return
    const { [key]: _landed, ...rest } = byKey
    if (Object.keys(rest).length) failedLoads.value[sessionId] = rest
    else delete failedLoads.value[sessionId]
  }

  function putSession(view: GuidedReviewSessionView) {
    sessions.value[view.session.id] = view
    clearFailure(view.session.id, sessionKey(view.session.id))
  }

  function putThread(view: GuidedReviewThreadView) {
    threads.value[view.thread.id] = view
    clearFailure(view.thread.sessionId, threadKey(view.thread.sessionId, view.thread.id))
  }

  function loadSession(sessionId: string): Promise<void> {
    const ws = workspace.requireId()
    return latest(sessionKey(sessionId), () => api.getGuidedReview(ws, sessionId), putSession)
  }

  function loadThread(sessionId: string, threadId: string): Promise<void> {
    const ws = workspace.requireId()
    return latest(
      threadKey(sessionId, threadId),
      () => api.getGuidedReviewThread(ws, sessionId, threadId),
      putThread,
    )
  }

  async function open(input: OpenGuidedReviewInput): Promise<GuidedReviewSessionView> {
    const view = await api.openGuidedReview(workspace.requireId(), input)
    claim(sessionKey(view.session.id))
    putSession(view)
    return view
  }

  /**
   * Refresh the session from the pull request. Threads whose background refetch failed are
   * loaded again with it, so an explicit refresh clears every reason the window has to say it may
   * be out of date, not only the session's own.
   */
  async function refresh(sessionId: string): Promise<void> {
    const ws = workspace.requireId()
    const failedThreads = Object.values(threads.value).filter(
      ({ thread }) =>
        thread.sessionId === sessionId &&
        threadKey(sessionId, thread.id) in (failedLoads.value[sessionId] ?? {}),
    )
    await Promise.all([
      latest(sessionKey(sessionId), () => api.refreshGuidedReview(ws, sessionId), putSession),
      ...failedThreads.map(({ thread }) => loadThread(sessionId, thread.id)),
    ])
  }

  async function remove(sessionId: string): Promise<void> {
    await api.deleteGuidedReview(workspace.requireId(), sessionId)
    forget(sessionId)
  }

  async function openThread(
    sessionId: string,
    input: OpenGuidedReviewThreadInput,
  ): Promise<GuidedReviewThreadView> {
    const view = await api.openGuidedReviewThread(workspace.requireId(), sessionId, input)
    claim(threadKey(sessionId, view.thread.id))
    putThread(view)
    await loadSession(sessionId)
    return view
  }

  async function ask(sessionId: string, threadId: string, input: AskGuidedReviewInput) {
    await api.askGuidedReview(workspace.requireId(), sessionId, threadId, input)
    await Promise.all([loadThread(sessionId, threadId), loadSession(sessionId)])
  }

  async function requestDrafts(sessionId: string, threadId: string, instructions = '') {
    await api.requestGuidedReviewDrafts(workspace.requireId(), sessionId, threadId, instructions)
    await Promise.all([loadThread(sessionId, threadId), loadSession(sessionId)])
  }

  async function editDraft(
    sessionId: string,
    draftId: string,
    input: EditGuidedReviewDraftInput,
  ): Promise<GuidedReviewCommentDraft> {
    const draft = await api.editGuidedReviewDraft(workspace.requireId(), sessionId, draftId, input)
    await loadSession(sessionId)
    return draft
  }

  async function postDrafts(
    sessionId: string,
    draftIds: string[],
    summary?: string,
  ): Promise<GuidedReviewPostResult> {
    const result = await api.postGuidedReviewDrafts(workspace.requireId(), sessionId, {
      draftIds,
      ...(summary?.trim() ? { summary } : {}),
    })
    await loadSession(sessionId)
    return result
  }

  function forget(sessionId: string) {
    delete sessions.value[sessionId]
    delete failedLoads.value[sessionId]
    newest.delete(sessionKey(sessionId))
    const threadPrefix = threadKey(sessionId, '')
    for (const key of newest.keys()) {
      if (key.startsWith(threadPrefix)) newest.delete(key)
    }
    for (const [id, view] of Object.entries(threads.value)) {
      if (view.thread.sessionId === sessionId) delete threads.value[id]
    }
  }

  /** Drop everything on a board switch; fetches still in flight for the old board never land. */
  function reset() {
    sessions.value = {}
    threads.value = {}
    failedLoads.value = {}
    newest.clear()
  }

  /**
   * A refetch nobody awaits (a live event, a reconnect). A session that answers 404 is gone and
   * is forgotten; any other failure keeps the last view and is recorded in `failedLoads`
   * against `key`, the fetch that failed.
   */
  async function follow(sessionId: string, key: string, load: () => Promise<void>): Promise<void> {
    try {
      await load()
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        forget(sessionId)
        return
      }
      if (sessions.value[sessionId]) recordFailure(sessionId, key, error)
    }
  }

  /** Follow a live `guidedReview` event: refetch what this client has loaded, nothing else. */
  async function applyChange(change: GuidedReviewChange): Promise<void> {
    if (change.scope === 'deleted') {
      forget(change.sessionId)
      return
    }
    const { sessionId } = change
    const loads: Promise<void>[] = []
    // A thread change also moves the session's summary (its pending answer), so both refetch.
    if (sessions.value[sessionId]) {
      loads.push(follow(sessionId, sessionKey(sessionId), () => loadSession(sessionId)))
    }
    if (change.scope === 'thread' || change.scope === 'drafts') {
      const { threadId } = change
      if (threads.value[threadId]) {
        loads.push(
          follow(sessionId, threadKey(sessionId, threadId), () => loadThread(sessionId, threadId)),
        )
      }
    }
    await Promise.all(loads)
  }

  /** Refetch everything loaded here, for events missed while the stream was disconnected. */
  async function resync(): Promise<void> {
    const loads = [
      ...Object.keys(sessions.value).map((id) => follow(id, sessionKey(id), () => loadSession(id))),
      ...Object.values(threads.value).map(({ thread }) =>
        follow(thread.sessionId, threadKey(thread.sessionId, thread.id), () =>
          loadThread(thread.sessionId, thread.id),
        ),
      ),
    ]
    await Promise.all(loads)
  }

  return {
    sessions,
    threads,
    failedLoads,
    refetchFailures,
    loadSession,
    loadThread,
    open,
    refresh,
    remove,
    openThread,
    ask,
    requestDrafts,
    editDraft,
    postDrafts,
    applyChange,
    resync,
    reset,
  }
})
