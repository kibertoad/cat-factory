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
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Guided PR review sessions and the threads a window has opened, loaded on demand and kept live
 * by `guidedReview` stream events. An event carries ids only, so `applyChange` refetches what is
 * loaded here and ignores the rest. Every refetch takes a ticket and only the newest ticket's
 * response lands, so a change that arrives mid-fetch is never lost to a stale reply.
 */
export const useGuidedReviewStore = defineStore('guidedReview', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const sessions = ref<Record<string, GuidedReviewSessionView>>({})
  const threads = ref<Record<string, GuidedReviewThreadView>>({})
  const tickets = new Map<string, number>()

  function workspaceId(): string {
    if (!workspace.workspaceId) throw new Error('No active workspace')
    return workspace.workspaceId
  }

  /** Run `fetch` for `key`, landing its result only if no newer fetch for that key started. */
  async function latest<T>(key: string, fetch: () => Promise<T>, land: (value: T) => void) {
    const ticket = (tickets.get(key) ?? 0) + 1
    tickets.set(key, ticket)
    const value = await fetch()
    if (tickets.get(key) === ticket) land(value)
  }

  function putSession(view: GuidedReviewSessionView) {
    sessions.value[view.session.id] = view
  }

  function putThread(view: GuidedReviewThreadView) {
    threads.value[view.thread.id] = view
  }

  function loadSession(sessionId: string): Promise<void> {
    const ws = workspaceId()
    return latest(`s:${sessionId}`, () => api.getGuidedReview(ws, sessionId), putSession)
  }

  function loadThread(sessionId: string, threadId: string): Promise<void> {
    const ws = workspaceId()
    return latest(
      `t:${threadId}`,
      () => api.getGuidedReviewThread(ws, sessionId, threadId),
      putThread,
    )
  }

  async function open(input: OpenGuidedReviewInput): Promise<GuidedReviewSessionView> {
    const view = await api.openGuidedReview(workspaceId(), input)
    putSession(view)
    return view
  }

  async function refresh(sessionId: string): Promise<void> {
    putSession(await api.refreshGuidedReview(workspaceId(), sessionId))
  }

  async function remove(sessionId: string): Promise<void> {
    await api.deleteGuidedReview(workspaceId(), sessionId)
    forget(sessionId)
  }

  async function openThread(
    sessionId: string,
    input: OpenGuidedReviewThreadInput,
  ): Promise<GuidedReviewThreadView> {
    const view = await api.openGuidedReviewThread(workspaceId(), sessionId, input)
    putThread(view)
    await loadSession(sessionId)
    return view
  }

  async function ask(sessionId: string, threadId: string, input: AskGuidedReviewInput) {
    await api.askGuidedReview(workspaceId(), sessionId, threadId, input)
    await Promise.all([loadThread(sessionId, threadId), loadSession(sessionId)])
  }

  async function requestDrafts(sessionId: string, threadId: string, instructions = '') {
    await api.requestGuidedReviewDrafts(workspaceId(), sessionId, threadId, instructions)
    await Promise.all([loadThread(sessionId, threadId), loadSession(sessionId)])
  }

  async function editDraft(
    sessionId: string,
    draftId: string,
    input: EditGuidedReviewDraftInput,
  ): Promise<GuidedReviewCommentDraft> {
    const draft = await api.editGuidedReviewDraft(workspaceId(), sessionId, draftId, input)
    await loadSession(sessionId)
    return draft
  }

  async function postDrafts(
    sessionId: string,
    draftIds: string[],
    summary?: string,
  ): Promise<GuidedReviewPostResult> {
    const result = await api.postGuidedReviewDrafts(workspaceId(), sessionId, {
      draftIds,
      ...(summary?.trim() ? { summary } : {}),
    })
    await loadSession(sessionId)
    return result
  }

  function forget(sessionId: string) {
    delete sessions.value[sessionId]
    for (const [id, view] of Object.entries(threads.value)) {
      if (view.thread.sessionId === sessionId) delete threads.value[id]
    }
  }

  /** Follow a live `guidedReview` event: refetch what this client has loaded, nothing else. */
  async function applyChange(change: GuidedReviewChange): Promise<void> {
    if (change.scope === 'deleted') {
      forget(change.sessionId)
      return
    }
    const loads: Promise<void>[] = []
    // A thread change also moves the session's summary (its pending answer), so both refetch.
    if (sessions.value[change.sessionId]) loads.push(loadSession(change.sessionId))
    if (change.scope === 'thread' && change.threadId && threads.value[change.threadId]) {
      loads.push(loadThread(change.sessionId, change.threadId))
    }
    await Promise.all(loads)
  }

  return {
    sessions,
    threads,
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
  }
})
