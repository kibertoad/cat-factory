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
  // Mirrors the backend's opt-in gate (`OBSERVABILITY_ENABLED`): `null` until first
  // probed, then `true`/`false`. The hub + inspector hide their observability entry
  // points when this is false, so a disabled backend doesn't surface a dead control.
  const available = ref<boolean | null>(null)
  let inFlight: Promise<void> | null = null

  /** Force a refresh of the connection + per-block configs (used after a save/remove). */
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
      available.value = true
    } catch {
      // 503 (observability disabled) or any error → hide the UI entry points.
      available.value = false
      connection.value = { connected: false, provider: null, summary: null }
      configs.value = []
    } finally {
      loading.value = false
    }
  }

  /**
   * Load once and share the result: repeated hub opens / frame-inspector mounts reuse
   * the resolved state (and coalesce a concurrent in-flight request) instead of each
   * re-fetching the connection + the whole configs list. Use `load()` to force a refresh.
   */
  async function ensureLoaded() {
    if (available.value !== null) return
    if (!inFlight) inFlight = load().finally(() => (inFlight = null))
    return inFlight
  }

  async function saveConnection(input: UpsertObservabilityConnectionInput) {
    const ws = useWorkspaceStore()
    connection.value = await api.setObservabilityConnection(ws.requireId(), input)
    available.value = true
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
    available,
    load,
    ensureLoaded,
    saveConnection,
    removeConnection,
    configForBlock,
    saveConfig,
    removeConfig,
  }
})
