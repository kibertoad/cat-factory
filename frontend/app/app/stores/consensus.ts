import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ConsensusSession } from '~/types/consensus'
import { useWorkspaceStore } from '~/stores/workspace'
import { useSingleFlight } from '~/composables/useSingleFlight'
import { isFeatureOffRefusal } from '~/composables/api/errors'

/**
 * Consensus session state. A consensus-enabled step runs a multi-model process (panel /
 * debate / ranked voting); its transcript is pushed live via the `consensus` stream event
 * and patched here by `upsert`. The dedicated window loads the latest session for a block
 * on open (`load`) so a reload shows a completed session. Per-workspace; nothing persisted
 * client-side.
 */
export const useConsensusStore = defineStore('consensus', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** The latest session per block id (null = fetched, none exists / consensus off). */
  const sessions = ref<Record<string, ConsensusSession | null>>({})
  /** Block ids whose session is currently being fetched. */
  const loading = ref<Set<string>>(new Set())
  /**
   * Block ids whose last fetch failed with anything but the 503 of a deployment with consensus
   * off. Kept apart from `sessions`: a failed read and "no session" need different renders.
   */
  const failed = ref<Set<string>>(new Set())
  /** One in-flight fetch per block: the window and its opener both load on open. */
  const loads = useSingleFlight<string, void>()

  function sessionFor(blockId: string): ConsensusSession | null {
    return sessions.value[blockId] ?? null
  }

  function isLoading(blockId: string): boolean {
    return loading.value.has(blockId)
  }

  function loadFailed(blockId: string): boolean {
    return failed.value.has(blockId)
  }

  function setFailed(blockId: string, on: boolean) {
    if (failed.value.has(blockId) === on) return
    const next = new Set(failed.value)
    if (on) next.add(blockId)
    else next.delete(blockId)
    failed.value = next
  }

  /**
   * Write one block's session into the cache, IN PLACE: per-key, never a whole-record clone.
   * `sessions` is a deep reactive ref, so replacing the record retriggered every consumer keyed on
   * an UNCHANGED block; assigning the key retriggers only the block that actually changed.
   */
  function store(session: ConsensusSession) {
    sessions.value[session.blockId] = session
  }

  /** Patch the cache from a live `consensus` stream event (newest wins per block). */
  function upsert(session: ConsensusSession) {
    const existing = sessions.value[session.blockId]
    // Keep the freshest by updatedAt so out-of-order pushes don't regress the transcript.
    if (existing && existing.id === session.id && existing.updatedAt > session.updatedAt) return
    store(session)
  }

  /**
   * Load the latest session for a block (window open / reload). Never rejects: a failure is
   * recorded on `loadFailed` for the window to state.
   */
  function load(blockId: string): Promise<void> {
    return loads.run(blockId, () => fetchSession(blockId))
  }

  async function fetchSession(blockId: string): Promise<void> {
    const wsId = workspace.workspaceId
    if (!wsId) return
    loading.value = new Set(loading.value).add(blockId)
    try {
      const { session } = await api.getConsensusSession(wsId, blockId)
      setFailed(blockId, false)
      // Reconcile rather than blind-replace: a `load` resolving AFTER a fresher live
      // `consensus` push (or after a newer concurrent load) must not regress the transcript —
      // the out-of-order-overwrite hazard the AGENTS.md live-push rules warn about. Keep
      // whichever session is newer by `updatedAt` (any id), and never overwrite an existing
      // (possibly live-pushed) session with a raced "none".
      const existing = sessions.value[blockId]
      if (session) {
        if (!existing || session.updatedAt >= existing.updatedAt) store(session)
      } else if (existing === undefined) {
        sessions.value[blockId] = null
      }
    } catch (error) {
      // "No session" is a `session: null` answer, so only a failure reaches here. A 503 is a
      // deployment with consensus off, which has no session to show. Anything else is a read that
      // did not answer, and the window must say so rather than show its empty state.
      if (isFeatureOffRefusal(error)) {
        setFailed(blockId, false)
        if (sessions.value[blockId] === undefined) sessions.value[blockId] = null
      } else {
        setFailed(blockId, true)
      }
    } finally {
      const next = new Set(loading.value)
      next.delete(blockId)
      loading.value = next
    }
  }

  /** Drop all cached sessions + in-flight state (called on workspace switch). */
  function reset() {
    sessions.value = {}
    loading.value = new Set()
    failed.value = new Set()
  }

  return { sessions, sessionFor, isLoading, loadFailed, load, upsert, reset }
})
