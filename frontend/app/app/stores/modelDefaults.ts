import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's per-agent-kind default model overrides — the map an agent step
 * resolves its model from when the task pins none (a block-pinned model still
 * wins; a kind absent from the map falls back to the deployment's env routing).
 * Hydrated from the workspace snapshot; edited via the Default-models settings
 * panel, which replaces the whole map on save.
 */
export const useModelDefaultsStore = defineStore('modelDefaults', () => {
  const api = useApi()

  /** agentKind → model catalog id. */
  const defaults = ref<Record<string, string>>({})

  function hydrate(map: Record<string, string> | undefined) {
    defaults.value = { ...map }
  }

  /** The model id chosen for a kind, or undefined when it falls back to routing. */
  function forKind(kind: string): string | undefined {
    return defaults.value[kind]
  }

  /**
   * Set (or, with `null`, clear) the default model for a single agent kind, then
   * persist the whole map. The backend replaces the stored set on every write.
   */
  async function set(kind: string, modelId: string | null) {
    const next = { ...defaults.value }
    if (modelId) next[kind] = modelId
    else delete next[kind]
    const ws = useWorkspaceStore()
    const saved = await api.setModelDefaults(ws.requireId(), next)
    defaults.value = { ...saved.defaults }
  }

  return { defaults, hydrate, forKind, set }
})
