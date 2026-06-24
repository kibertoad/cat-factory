import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  OpenRouterModelMeta,
  OpenRouterRefreshResult,
} from '~/types/openrouter'

// The workspace's OpenRouter dynamic catalog: the enabled subset of OpenRouter's 300+
// gateway models. `enabled` is what's persisted (and surfaced in the model picker);
// `browse` is the live catalog from the last `refresh` (not persisted) the user picks from.
// Scoped to the workspace (its key lives in the workspace API-key pool).
export const useOpenRouterStore = defineStore('openrouter', () => {
  const api = useApi()
  const enabled = ref<OpenRouterModelMeta[]>([])
  const browse = ref<OpenRouterModelMeta[]>([])
  const loading = ref(false)
  const refreshing = ref(false)
  const refreshError = ref<string | null>(null)

  async function load(workspaceId: string) {
    loading.value = true
    try {
      const catalog = await api.getOpenRouterCatalog(workspaceId)
      enabled.value = catalog.models
    } catch {
      // Auth disabled / not signed in / feature off → nothing surfaces.
      enabled.value = []
    } finally {
      loading.value = false
    }
  }

  /** Probe OpenRouter's live catalog (leases the workspace's pooled key server-side). */
  async function refresh(workspaceId: string): Promise<OpenRouterRefreshResult> {
    refreshing.value = true
    refreshError.value = null
    try {
      const result = await api.refreshOpenRouterCatalog(workspaceId)
      browse.value = result.models
      if (!result.reachable) refreshError.value = result.error ?? 'OpenRouter is unreachable'
      return result
    } finally {
      refreshing.value = false
    }
  }

  /** Persist the enabled subset (the supplied models carry their browse-list metadata). */
  async function save(workspaceId: string, models: OpenRouterModelMeta[]) {
    const catalog = await api.setOpenRouterCatalog(workspaceId, { models })
    enabled.value = catalog.models
    return catalog
  }

  return { enabled, browse, loading, refreshing, refreshError, load, refresh, save }
})
