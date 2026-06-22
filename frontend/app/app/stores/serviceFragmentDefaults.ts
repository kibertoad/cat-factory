import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's default service-fragment selection — the best-practice fragment ids
 * a NEW service inherits onto its `serviceFragmentIds`. Hydrated from the workspace
 * snapshot; edited via the Default-service-fragments settings panel, which replaces
 * the whole list on save. Changing it does not retroactively change existing services.
 */
export const useServiceFragmentDefaultsStore = defineStore('serviceFragmentDefaults', () => {
  const api = useApi()

  /** The default fragment ids new services inherit. */
  const fragmentIds = ref<string[]>([])

  function hydrate(ids: string[] | undefined) {
    fragmentIds.value = [...(ids ?? [])]
  }

  /** Replace the whole default list and persist it. */
  async function set(ids: string[]) {
    const ws = useWorkspaceStore()
    const saved = await api.setServiceFragmentDefaults(ws.requireId(), ids)
    fragmentIds.value = [...saved.fragmentIds]
  }

  return { fragmentIds, hydrate, set }
})
