import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { ProvisioningLogEntry, ProvisioningSubsystem } from '~/types/provisioningLogs'
import { useWorkspaceStore } from '~/stores/workspace'

interface LogState {
  entries: ProvisioningLogEntry[]
  loading: boolean
  error: string | null
}

function emptyState(): LogState {
  return { entries: [], loading: false, error: null }
}

/**
 * The unified provisioning event log, loaded on demand for two surfaces:
 *   - per SUBSYSTEM, for the "View logs" drawers in the environment-provider and
 *     self-hosted runner-pool config panels;
 *   - per EXECUTION (run), for the "Infrastructure attempts" drawer in a run's step
 *     details — this is the surface that makes the `container` rows (per-run container
 *     dispatch/release/poll-failure) and the `executionId` filter visible.
 * Each shows every spin-up/tear-down attempt with its outcome + the exact error.
 */
export const useProvisioningLogsStore = defineStore('provisioningLogs', () => {
  const api = useApi()
  const bySubsystem = reactive<Record<ProvisioningSubsystem, LogState>>({
    environment: emptyState(),
    'runner-pool': emptyState(),
    container: emptyState(),
  })
  const byExecution = reactive<Record<string, LogState>>({})

  async function load(subsystem: ProvisioningSubsystem) {
    const ws = useWorkspaceStore()
    const s = bySubsystem[subsystem]
    s.loading = true
    s.error = null
    try {
      const { entries } = await api.listProvisioningLogs(ws.requireId(), { subsystem, limit: 200 })
      s.entries = entries
    } catch (err) {
      s.error = err instanceof Error ? err.message : 'Failed to load logs'
      s.entries = []
    } finally {
      s.loading = false
    }
  }

  /**
   * Load a run's provisioning attempts. `silent` is for the drawer's background poll
   * while the run is live: it must NOT flip the `loading` spinner (it would flicker
   * every poll) and a transient failure must NOT clear the last-good entries or surface
   * an error banner — the visible refresh path (initial open / manual refresh) owns those.
   */
  async function loadForExecution(executionId: string, opts?: { silent?: boolean }) {
    const ws = useWorkspaceStore()
    const s = (byExecution[executionId] ??= emptyState())
    if (!opts?.silent) {
      s.loading = true
      s.error = null
    }
    try {
      const { entries } = await api.listProvisioningLogs(ws.requireId(), {
        executionId,
        limit: 200,
      })
      s.entries = entries
      s.error = null
    } catch (err) {
      // A background poll keeps the last snapshot on a blip; only a visible load reports.
      if (!opts?.silent) {
        s.error = err instanceof Error ? err.message : 'Failed to load logs'
        s.entries = []
      }
    } finally {
      if (!opts?.silent) s.loading = false
    }
  }

  return { bySubsystem, byExecution, load, loadForExecution }
})
