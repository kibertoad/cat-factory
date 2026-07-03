import { defineStore } from 'pinia'
import { ref } from 'vue'
import {
  boundServiceFrameIds,
  indexLiveServiceEnvUrls,
  type FrontendConfig,
} from '@cat-factory/contracts'
import type { EnvironmentHandle } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's live ephemeral-environment handles, fetched on demand from
 * `GET /workspaces/:ws/environments`. Used to resolve a `frontend` frame's backend bindings to
 * their live service URLs (the SPA mirror of the backend's `AgentContextBuilder` resolution) — so
 * the inspector and the run/step detail can show each `envVar → live URL | mocked` the SAME way a
 * UI-test run would. Kept as a thin, load-on-open cache (no snapshot delivery, no self-poll):
 * the callers refresh it when the frontend inspector / a UI-test step detail opens.
 */
export const useEnvironmentsStore = defineStore('environments', () => {
  const api = useApi()

  /** The last-fetched env handles for the current workspace. */
  const handles = ref<EnvironmentHandle[]>([])
  /** A load is in flight (drives an optional spinner). */
  const loading = ref(false)

  /** (Re)load the workspace's environment handles; failures leave the last-known list. */
  async function load(): Promise<void> {
    const ws = useWorkspaceStore()
    loading.value = true
    try {
      handles.value = await api.listEnvironments(ws.requireId())
    } catch {
      // Transient: keep the last-known handles rather than blanking the resolved view.
    } finally {
      loading.value = false
    }
  }

  /**
   * The live `serviceFrameId → url` map for exactly the service FRAMES a frontend config binds —
   * the same newest-wins, ready-with-URL indexing the backend applies (`indexLiveServiceEnvUrls`),
   * so the SPA's resolved-binding view can't drift from what a run would resolve.
   */
  function liveServiceEnvUrls(
    config: Pick<FrontendConfig, 'backendBindings'>,
  ): Map<string, string> {
    return indexLiveServiceEnvUrls(handles.value, boundServiceFrameIds(config))
  }

  return { handles, loading, load, liveServiceEnvUrls }
})
