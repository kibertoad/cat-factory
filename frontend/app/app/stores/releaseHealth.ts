import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  DatadogConnectionView,
  ReleaseHealthConfig,
  UpsertDatadogConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's Datadog post-release-health settings: the (single) connection — keys
 * are write-only, never read back — and the per-block monitor/SLO mappings the
 * `post-release-health` gate reads. Loaded on demand (the settings panel), not from the
 * snapshot, since the secrets never leave the server.
 */
export const useReleaseHealthStore = defineStore('releaseHealth', () => {
  const api = useApi()

  const connection = ref<DatadogConnectionView>({ connected: false, site: null })
  const configs = ref<ReleaseHealthConfig[]>([])
  const loading = ref(false)

  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      const [conn, list] = await Promise.all([
        api.getDatadogConnection(ws.requireId()),
        api.listReleaseHealthConfigs(ws.requireId()),
      ])
      connection.value = conn
      configs.value = list
    } finally {
      loading.value = false
    }
  }

  async function saveConnection(input: UpsertDatadogConnectionInput) {
    const ws = useWorkspaceStore()
    connection.value = await api.setDatadogConnection(ws.requireId(), input)
  }

  async function removeConnection() {
    const ws = useWorkspaceStore()
    await api.deleteDatadogConnection(ws.requireId())
    connection.value = { connected: false, site: null }
  }

  async function saveConfig(blockId: string, input: UpsertReleaseHealthConfigInput) {
    const ws = useWorkspaceStore()
    const saved = await api.upsertReleaseHealthConfig(ws.requireId(), blockId, input)
    const idx = configs.value.findIndex((c) => c.blockId === blockId)
    if (idx >= 0) configs.value[idx] = saved
    else configs.value.push(saved)
    return saved
  }

  async function removeConfig(blockId: string) {
    const ws = useWorkspaceStore()
    await api.deleteReleaseHealthConfig(ws.requireId(), blockId)
    configs.value = configs.value.filter((c) => c.blockId !== blockId)
  }

  return {
    connection,
    configs,
    loading,
    load,
    saveConnection,
    removeConnection,
    saveConfig,
    removeConfig,
  }
})
