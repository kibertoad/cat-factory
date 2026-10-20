import { defineStore } from 'pinia'
import { ref } from 'vue'
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
   * The last error of a background refetch per session, cleared when that session or one of its
   * threads lands again, so a window can say its view may be out of date.
   */
  const refetchFailures = ref<Record<string, unknown>>({})
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

  /** Run `fetch` for `key`, landing its result only if no newer fetch or write for it started. */
  async function latest<T>(key: string, fetch: () => Promise<T>, land: (value: T) => void) {
    const ticket = claim(key)
    const value = await fetch()
    if (newest.get(key) === ticket) land(value)
  }

  function putSession(view: GuidedReviewSessionView) {
    sessions.value[view.session.id] = view
    delete refetchFailures.value[view.session.id]
  }

  function putThread(view: GuidedReviewThreadView) {
    threads.value[view.thread.id] = view
    delete refetchFailures.value[view.thread.sessionId]
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

  function refresh(sessionId: string): Promise<void> {
    const ws = workspace.requireId()
    return latest(sessionKey(sessionId), () => api.refreshGuidedReview(ws, sessionId), putSession)
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
    delete refetchFailures.value[sessionId]
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
    refetchFailures.value = {}
    newest.clear()
  }

  /**
   * A refetch nobody awaits (a live event, a reconnect). A session that answers 404 is gone and
   * is forgotten; any other failure keeps the last view and is recorded in `refetchFailures`.
   */
  async function follow(sessionId: string, load: () => Promise<void>): Promise<void> {
    try {
      await load()
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 404) {
        forget(sessionId)
        return
      }
      if (sessions.value[sessionId]) refetchFailures.value[sessionId] = error
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
      loads.push(follow(sessionId, () => loadSession(sessionId)))
    }
    if (change.scope === 'thread' || change.scope === 'drafts') {
      const { threadId } = change
      if (threads.value[threadId]) {
        loads.push(follow(sessionId, () => loadThread(sessionId, threadId)))
      }
    }
    await Promise.all(loads)
  }

  /** Refetch everything loaded here, for events missed while the stream was disconnected. */
  async function resync(): Promise<void> {
    const loads = [
      ...Object.keys(sessions.value).map((id) => follow(id, () => loadSession(id))),
      ...Object.values(threads.value).map(({ thread }) =>
        follow(thread.sessionId, () => loadThread(thread.sessionId, thread.id)),
      ),
    ]
    await Promise.all(loads)
  }

  return {
    sessions,
    threads,
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
