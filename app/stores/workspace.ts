import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { WorkspaceSnapshot } from '~/types/domain'
import { useBoardStore } from '~/stores/board'
import { usePipelinesStore } from '~/stores/pipelines'
import { useExecutionStore } from '~/stores/execution'

/**
 * Owns the active workspace and bootstraps the app against the backend. On load
 * it reuses the persisted workspace (or creates a seeded one), fetches the full
 * snapshot and hydrates the board / pipelines / execution stores from it.
 *
 * Only the workspace id is persisted — all board data lives on the server.
 */
export const useWorkspaceStore = defineStore(
  'workspace',
  () => {
    const api = useApi()

    /** Active workspace id (persisted so a reload reopens the same board). */
    const workspaceId = ref<string | null>(null)
    /** True once the initial snapshot has been loaded and stores hydrated. */
    const ready = ref(false)
    /** Set when bootstrap fails so the UI can show a retry. */
    const error = ref<string | null>(null)

    /** Push a snapshot into the data stores. */
    function hydrate(snapshot: WorkspaceSnapshot) {
      workspaceId.value = snapshot.workspace.id
      useBoardStore().hydrate(snapshot.blocks)
      usePipelinesStore().hydrate(snapshot.pipelines)
      useExecutionStore().hydrate(snapshot.executions)
    }

    /** Load the persisted workspace, falling back to an existing or fresh one. */
    async function init() {
      ready.value = false
      error.value = null
      try {
        if (workspaceId.value) {
          try {
            hydrate(await api.getWorkspace(workspaceId.value))
            ready.value = true
            return
          } catch {
            // Persisted workspace is gone (e.g. backend reset) — fall through.
            workspaceId.value = null
          }
        }

        const existing = await api.listWorkspaces()
        const first = existing[0]
        const snapshot = first
          ? await api.getWorkspace(first.id)
          : await api.createWorkspace({ seed: true })
        hydrate(snapshot)
        ready.value = true
      } catch (e) {
        error.value = e instanceof Error ? e.message : 'Failed to reach the backend.'
      }
    }

    /** Re-fetch the snapshot and re-hydrate (used after server-side ticks). */
    async function refresh() {
      if (!workspaceId.value) return
      hydrate(await api.getWorkspace(workspaceId.value))
    }

    /** Discard the current workspace and start a fresh, seeded one. */
    async function reset() {
      const prev = workspaceId.value
      workspaceId.value = null
      hydrate(await api.createWorkspace({ seed: true }))
      if (prev) await api.deleteWorkspace(prev).catch(() => {})
    }

    /** The active workspace id, or throw if the app isn't bootstrapped yet. */
    function requireId(): string {
      if (!workspaceId.value) throw new Error('No active workspace')
      return workspaceId.value
    }

    return { workspaceId, ready, error, init, refresh, reset, requireId }
  },
  { persist: { pick: ['workspaceId'] } },
)
