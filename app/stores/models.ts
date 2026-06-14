import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ModelOption } from '~/types/domain'

/**
 * The model picker catalog. Served by `GET /models`, where each model is already
 * resolved to the flavour in use for this deployment (direct when the provider's
 * key is configured, else the Cloudflare fallback). Fetched once and cached for
 * the per-block picker, and used to label which model produced a step's output.
 */
export const useModelsStore = defineStore('models', () => {
  const api = useApi()
  const models = ref<ModelOption[]>([])
  const loaded = ref(false)

  /** Fetch the catalog once; subsequent calls are no-ops. */
  async function ensureLoaded() {
    if (loaded.value) return
    models.value = await api.getModels()
    loaded.value = true
  }

  const byId = computed(() => {
    const map = new Map<string, ModelOption>()
    for (const m of models.value) map.set(m.id, m)
    return map
  })

  function getModel(id: string | undefined) {
    return id ? byId.value.get(id) : undefined
  }

  /**
   * Friendly label for a recorded `provider:model` identifier (as carried on a
   * pipeline step). Matches it against the catalog's effective refs; falls back
   * to the bare model id for anything not in the catalog (e.g. a pinned override).
   */
  function labelForRef(ref: string | undefined): string | undefined {
    if (!ref) return undefined
    const idx = ref.indexOf(':')
    const provider = idx === -1 ? ref : ref.slice(0, idx)
    const model = idx === -1 ? '' : ref.slice(idx + 1)
    const hit = models.value.find((m) => m.provider === provider && m.model === model)
    return hit ? `${hit.label} · ${hit.providerLabel}` : model || ref
  }

  return { models, loaded, ensureLoaded, byId, getModel, labelForRef }
})
