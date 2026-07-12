import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { ConsensusSession } from '~/types/consensus'
import { useWorkspaceStore } from '~/stores/workspace'

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

  function sessionFor(blockId: string): ConsensusSession | null {
    return sessions.value[blockId] ?? null
  }

  function isLoading(blockId: string): boolean {
    return loading.value.has(blockId)
  }

  function store(session: ConsensusSession) {
    sessions.value = { ...sessions.value, [session.blockId]: session }
  }

  /** Patch the cache from a live `consensus` stream event (newest wins per block). */
  function upsert(session: ConsensusSession) {
    const existing = sessions.value[session.blockId]
    // Keep the freshest by updatedAt so out-of-order pushes don't regress the transcript.
    if (existing && existing.id === session.id && existing.updatedAt > session.updatedAt) return
    store(session)
  }

  /** Load the latest session for a block (window open / reload). Best-effort. */
  async function load(blockId: string): Promise<void> {
    const wsId = workspace.workspaceId
    if (!wsId) return
    loading.value = new Set(loading.value).add(blockId)
    try {
      const { session } = await api.getConsensusSession(wsId, blockId)
      // Reconcile rather than blind-replace: a `load` resolving AFTER a fresher live
      // `consensus` push (or after a newer concurrent load) must not regress the transcript —
      // the out-of-order-overwrite hazard the CLAUDE.md live-push rules warn about. Keep
      // whichever session is newer by `updatedAt` (any id), and never overwrite an existing
      // (possibly live-pushed) session with a raced "none".
      const existing = sessions.value[blockId]
      if (session) {
        if (!existing || session.updatedAt >= existing.updatedAt) store(session)
      } else if (existing === undefined) {
        sessions.value = { ...sessions.value, [blockId]: null }
      }
    } catch {
      // Consensus off / no session — leave the cache as-is; the window shows its empty state.
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
  }

  return { sessions, sessionFor, isLoading, load, upsert, reset }
})
