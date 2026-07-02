import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { BlockType, PromptFragment } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The best-practice prompt fragment catalog backing the per-service and per-block
 * pickers. When the fragment library is configured it loads the MERGED tenant
 * catalog for the active board (`GET /workspaces/:id/prompt-fragments/resolved` —
 * built-in ∪ account ∪ workspace, override-by-id, tombstones applied), so managed,
 * repo-sourced and document-backed fragments are selectable exactly like the
 * built-ins and a suppressed built-in disappears from the picker. When the library
 * is off (the resolved endpoint 503s) it falls back to the workspace-independent
 * static pool (`GET /prompt-fragments`). Cached per board; re-fetched on a board
 * switch or after `invalidate()` (a library edit).
 */
export const useFragmentsStore = defineStore('fragments', () => {
  const api = useApi()
  const fragments = ref<PromptFragment[]>([])
  const loaded = ref(false)
  /** The board the catalog was loaded for (null = never; '' = static pool, no board). */
  const loadedFor = ref<string | null>(null)

  /** Fetch the catalog for the active board; a no-op while it is current. */
  async function ensureLoaded() {
    const wsId = useWorkspaceStore().workspaceId ?? ''
    if (loaded.value && loadedFor.value === wsId) return
    // Prefer the merged tenant catalog; a 503 (library unconfigured) or any other
    // failure degrades to the static universal pool.
    const resolved = wsId ? await api.getResolvedFragments(wsId).catch(() => null) : null
    fragments.value = resolved ?? (await api.getPromptFragments())
    loadedFor.value = wsId
    loaded.value = true
  }

  /** Drop the cache so the next `ensureLoaded()` re-fetches (after a library edit). */
  function invalidate() {
    loaded.value = false
    loadedFor.value = null
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

  return { fragments, loaded, ensureLoaded, invalidate, byId, getFragment, forBlockType }
})
