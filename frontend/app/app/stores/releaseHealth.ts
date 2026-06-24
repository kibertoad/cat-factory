import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  ObservabilityConnectionView,
  ReleaseHealthConfig,
  UpsertObservabilityConnectionInput,
  UpsertReleaseHealthConfigInput,
} from '~/types/releaseHealth'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's post-release-health settings: the (single) observability connection —
 * provider + credentials, write-only, never read back — and the per-block monitor/SLO
 * mappings the `post-release-health` gate reads. Loaded on demand (the observability panel
 * + the service inspector), not from the snapshot, since the secrets never leave the server.
 */
export const useReleaseHealthStore = defineStore('releaseHealth', () => {
  const api = useApi()

  const connection = ref<ObservabilityConnectionView>({
    connected: false,
    provider: null,
    summary: null,
  })
  const configs = ref<ReleaseHealthConfig[]>([])
  const loading = ref(false)

  async function load() {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      const [conn, list] = await Promise.all([
        api.getObservabilityConnection(ws.requireId()),
        api.listReleaseHealthConfigs(ws.requireId()),
      ])
      connection.value = conn
      configs.value = list
    } finally {
      loading.value = false
    }
  }

  async function saveConnection(input: UpsertObservabilityConnectionInput) {
    const ws = useWorkspaceStore()
    connection.value = await api.setObservabilityConnection(ws.requireId(), input)
  }

  async function removeConnection() {
    const ws = useWorkspaceStore()
    await api.deleteObservabilityConnection(ws.requireId())
    connection.value = { connected: false, provider: null, summary: null }
  }

  /** The saved config for a specific block (the service inspector reads this). */
  function configForBlock(blockId: string): ReleaseHealthConfig | undefined {
    return configs.value.find((c) => c.blockId === blockId)
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
    configForBlock,
    saveConfig,
    removeConfig,
  }
})
