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

  /**
   * The deployment's env-routing defaults as `provider:model` refs — what a kind
   * runs on when neither the task nor this workspace pins a model. `default` is the
   * global fallback; `byKind` carries kinds the operator routed specifically. Used
   * only to NAME the fallback in the settings panel; it never overrides a pin.
   */
  const deployment = ref<{ default: string; byKind: Record<string, string> }>({
    default: '',
    byKind: {},
  })

  function hydrate(map: Record<string, string> | undefined) {
    defaults.value = { ...map }
  }

  function hydrateDeployment(
    next: { default: string; byKind: Record<string, string> } | undefined,
  ) {
    deployment.value = next ? { default: next.default, byKind: { ...next.byKind } } : {
      default: '',
      byKind: {},
    }
  }

  /** The model id chosen for a kind, or undefined when it falls back to routing. */
  function forKind(kind: string): string | undefined {
    return defaults.value[kind]
  }

  /** The deployment-routing model ref a kind falls back to (`byKind[kind] ?? default`). */
  function deploymentRefForKind(kind: string): string | undefined {
    return deployment.value.byKind[kind] || deployment.value.default || undefined
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

  return {
    defaults,
    deployment,
    hydrate,
    hydrateDeployment,
    forKind,
    deploymentRefForKind,
    set,
  }
})
