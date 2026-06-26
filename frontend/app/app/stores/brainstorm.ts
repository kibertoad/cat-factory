import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  BrainstormSession,
  BrainstormStage,
  ResolveBrainstormExceededChoice,
  ReviewItemStatus,
} from '~/types/brainstorm'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Brainstorm (structured-dialogue) state. On the pipeline path a brainstorm runs as an opt-in
 * gate step: the run parks while the human picks / steers / dismisses the proposed options, then
 * asks to incorporate. Incorporation + the re-run run ASYNCHRONOUSLY in the durable driver — the
 * call returns at once (status `incorporating`) and the user goes back to the board; they are
 * summoned again (a notification) only if the re-run yields options or hits the cap. The store is
 * patched both from call responses and from live `brainstorm` stream events (see `upsert`).
 *
 * A block may have one live session per STAGE (`requirements` / `architecture`), so the cache is
 * keyed by `${blockId}:${stage}`. `available` mirrors the backend's opt-in gate (a 503 hides the
 * UI). Per-workspace; nothing is persisted client-side.
 */
export const useBrainstormStore = defineStore('brainstorm', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  const key = (blockId: string, stage: BrainstormStage) => `${blockId}:${stage}`

  /** null = unknown (not probed), true/false = feature on/off. */
  const available = ref<boolean | null>(null)
  /** The current session per `${blockId}:${stage}` (null = fetched, none exists). */
  const sessions = ref<Record<string, BrainstormSession | null>>({})
  /** `${blockId}:${stage}` keys whose agent is currently running (run / re-run). */
  const running = ref<Set<string>>(new Set())
  /** Session ids currently incorporating their picks. */
  const incorporating = ref<Set<string>>(new Set())
  /** `${blockId}:${stage}` keys whose current session is being fetched (the initial `load`). */
  const loadingByKey = ref<Set<string>>(new Set())
  const inFlight = new Map<string, Promise<void>>()

  function sessionFor(blockId: string, stage: BrainstormStage): BrainstormSession | null {
    return sessions.value[key(blockId, stage)] ?? null
  }
  /** The async background stage a session is in, or null (so the board can show "working"). */
  function backgroundStage(
    blockId: string,
    stage: BrainstormStage,
  ): 'incorporating' | 'reviewing' | null {
    const status = sessions.value[key(blockId, stage)]?.status
    return status === 'incorporating' || status === 'reviewing' ? status : null
  }
  function isRunning(blockId: string, stage: BrainstormStage): boolean {
    return running.value.has(key(blockId, stage))
  }
  function isLoading(blockId: string, stage: BrainstormStage): boolean {
    return loadingByKey.value.has(key(blockId, stage))
  }
  function isIncorporating(sessionId: string): boolean {
    return incorporating.value.has(sessionId)
  }

  /** Options still needing a human (status `open`). */
  function openCount(session: BrainstormSession): number {
    return session.items.filter((i) => i.status === 'open').length
  }
  /** Options the human chose (a reply recorded), which the companion folds in. */
  function answeredCount(session: BrainstormSession): number {
    return session.items.filter((i) => i.status === 'answered' || i.status === 'resolved').length
  }
  /** Every option is settled (chosen or dismissed) — none still open. */
  function allSettled(session: BrainstormSession): boolean {
    return openCount(session) === 0
  }
  /** Incorporation is possible: all options settled AND at least one was chosen. */
  function canIncorporate(session: BrainstormSession): boolean {
    return allSettled(session) && answeredCount(session) > 0
  }
  /** Proceed (skip the companion) is possible: all options settled but none chosen. */
  function canProceed(session: BrainstormSession): boolean {
    return allSettled(session) && answeredCount(session) === 0
  }

  function store(session: BrainstormSession) {
    sessions.value = { ...sessions.value, [key(session.blockId, session.stage)]: session }
  }

  function withFlag(set: typeof running, k: string, on: boolean) {
    const next = new Set(set.value)
    if (on) next.add(k)
    else next.delete(k)
    set.value = next
  }

  /** Fetch the current session for a block + stage (probing the feature's availability). */
  async function load(blockId: string, stage: BrainstormStage) {
    if (!workspace.workspaceId) return
    const k = key(blockId, stage)
    const pending = inFlight.get(k)
    if (pending) return pending
    const promise = (async () => {
      withFlag(loadingByKey, k, true)
      try {
        const session = await api.getBrainstorm(workspace.requireId(), blockId, stage)
        available.value = true
        sessions.value = { ...sessions.value, [k]: session }
      } catch {
        available.value = false
      } finally {
        withFlag(loadingByKey, k, false)
        inFlight.delete(k)
      }
    })()
    inFlight.set(k, promise)
    return promise
  }

  /** Record a human's choice on one option. */
  async function reply(session: BrainstormSession, itemId: string, text: string) {
    store(await api.replyBrainstormItem(workspace.requireId(), session.id, itemId, text))
  }

  /** Set an option's status (dismiss / reopen). */
  async function setItemStatus(
    session: BrainstormSession,
    itemId: string,
    status: ReviewItemStatus,
  ) {
    store(await api.setBrainstormItemStatus(workspace.requireId(), session.id, itemId, status))
  }

  /**
   * Ask the driver to incorporate the picks ASYNCHRONOUSLY. Optional `feedback` is the "do it
   * differently" direction when redoing a merge. Returns at once with the `incorporating`
   * session (the fold + re-run happen in the background).
   */
  async function incorporate(session: BrainstormSession, feedback?: string) {
    withFlag(incorporating, session.id, true)
    try {
      const updated = await api.incorporateBrainstorm(
        workspace.requireId(),
        session.blockId,
        session.stage,
        feedback,
      )
      store(updated)
      return updated
    } finally {
      withFlag(incorporating, session.id, false)
    }
  }

  /** Re-run the brainstorm against the converged direction (one more pass; may converge/advance). */
  async function reReview(blockId: string, stage: BrainstormStage): Promise<BrainstormSession> {
    withFlag(running, key(blockId, stage), true)
    try {
      const updated = await api.reReviewBrainstorm(workspace.requireId(), blockId, stage)
      store(updated)
      return updated
    } finally {
      withFlag(running, key(blockId, stage), false)
    }
  }

  /** Proceed: settle the brainstorm and advance the parked run. */
  async function proceed(blockId: string, stage: BrainstormStage): Promise<BrainstormSession> {
    const updated = await api.proceedBrainstorm(workspace.requireId(), blockId, stage)
    store(updated)
    return updated
  }

  /** Resolve a capped session: extra-round / proceed / stop-reset. */
  async function resolveExceeded(
    blockId: string,
    stage: BrainstormStage,
    choice: ResolveBrainstormExceededChoice,
  ): Promise<BrainstormSession> {
    const updated = await api.resolveBrainstormExceeded(
      workspace.requireId(),
      blockId,
      stage,
      choice,
    )
    store(updated)
    return updated
  }

  return {
    available,
    sessions,
    sessionFor,
    backgroundStage,
    isRunning,
    isLoading,
    isIncorporating,
    openCount,
    answeredCount,
    allSettled,
    canIncorporate,
    canProceed,
    load,
    reply,
    setItemStatus,
    incorporate,
    reReview,
    proceed,
    resolveExceeded,
    // Patch the cache from a live `brainstorm` stream event.
    upsert: store,
  }
})
