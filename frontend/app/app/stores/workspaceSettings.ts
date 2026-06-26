import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { UpdateWorkspaceSettingsInput, WorkspaceSettings } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/** Built-in defaults, mirrored from the backend's DEFAULT_WORKSPACE_SETTINGS. */
const DEFAULTS: WorkspaceSettings = {
  waitingEscalationMinutes: 120,
  taskLimitMode: 'off',
  taskLimitShared: null,
  taskLimitPerType: null,
  storeAgentContext: true,
  spendCurrency: null,
  spendMonthlyLimit: null,
}

/**
 * The workspace's runtime settings — the human-wait escalation threshold (after which a
 * waiting notification turns red) and the per-service running-task limit policy. Hydrated
 * from the workspace snapshot; edited via the settings panel. Falls back to the built-in
 * defaults until the snapshot lands (or on an older server that doesn't send them).
 */
export const useWorkspaceSettingsStore = defineStore('workspaceSettings', () => {
  const api = useApi()
  const settings = ref<WorkspaceSettings>({ ...DEFAULTS })

  function hydrate(value: WorkspaceSettings | undefined) {
    settings.value = value ? { ...value } : { ...DEFAULTS }
  }

  async function update(patch: UpdateWorkspaceSettingsInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateWorkspaceSettings(ws.requireId(), patch)
    settings.value = updated
    return updated
  }

  return { settings, hydrate, update }
})
