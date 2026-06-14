import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { BlockType, PromptFragment } from '~/types/domain'

/**
 * The best-practice prompt fragment catalog. It is build-static reference data on
 * the backend (`GET /prompt-fragments`), workspace-independent, so this store
 * fetches it once and caches it for the per-block picker in the inspector.
 */
export const useFragmentsStore = defineStore('fragments', () => {
  const api = useApi()
  const fragments = ref<PromptFragment[]>([])
  const loaded = ref(false)

  /** Fetch the catalog once; subsequent calls are no-ops. */
  async function ensureLoaded() {
    if (loaded.value) return
    fragments.value = await api.getPromptFragments()
    loaded.value = true
  }

  const byId = computed(() => {
    const map = new Map<string, PromptFragment>()
    for (const f of fragments.value) map.set(f.id, f)
    return map
  })

  function getFragment(id: string) {
    return byId.value.get(id)
  }

  /** Fragments suitable for a block type (those with no `blockTypes` apply to all). */
  function forBlockType(type: BlockType) {
    return fragments.value.filter(
      (f) => !f.appliesTo?.blockTypes || f.appliesTo.blockTypes.includes(type),
    )
  }

  return { fragments, loaded, ensureLoaded, byId, getFragment, forBlockType }
})
