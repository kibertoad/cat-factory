import { defineStore } from 'pinia'
import { reactive } from 'vue'
import type { ProvisioningLogEntry, ProvisioningSubsystem } from '~/types/provisioningLogs'
import { useWorkspaceStore } from '~/stores/workspace'

interface SubsystemState {
  entries: ProvisioningLogEntry[]
  loading: boolean
  error: string | null
}

function emptyState(): SubsystemState {
  return { entries: [], loading: false, error: null }
}

/**
 * The unified provisioning event log, loaded per subsystem on demand for the "View
 * logs" drawers in the environment-provider and runner-pool config panels. Each
 * drawer shows every spin-up/tear-down attempt with its outcome + the exact error.
 */
export const useProvisioningLogsStore = defineStore('provisioningLogs', () => {
  const api = useApi()
  const bySubsystem = reactive<Record<ProvisioningSubsystem, SubsystemState>>({
    environment: emptyState(),
    'runner-pool': emptyState(),
    container: emptyState(),
  })

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

  return { bySubsystem, load }
})
