import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreatePromptFragmentInput,
  FragmentSource,
  LinkFragmentSourceInput,
  PromptFragment,
  ResolvedFragment,
  UpdatePromptFragmentInput,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Prompt-fragment library state (ADR 0006), scoped to the active board. Holds the
 * board's own (workspace-tier) fragments, its linked guideline repos, and the
 * merged catalog an agent actually sees (built-in ∪ account ∪ workspace). The
 * management surface targets the workspace tier; the resolved read is what every
 * agent run is selected from. `available` mirrors the backend's opt-in gate: a
 * 503 from the resolve probe means the feature is off and the UI hides its entry.
 */
export const useFragmentLibraryStore = defineStore('fragmentLibrary', () => {
  const api = useApi()
  const workspace = useWorkspaceStore()

  /** null = not probed yet; true/false = library on/off. */
  const available = ref<boolean | null>(null)
  /** This board's hand-authored + sourced fragments (workspace tier, raw). */
  const fragments = ref<PromptFragment[]>([])
  /** The merged catalog an agent sees (with each entry's winning tier). */
  const resolved = ref<ResolvedFragment[]>([])
  /** Linked guideline repos for this board. */
  const sources = ref<FragmentSource[]>([])
  /** Per-source "changes available" counts from the last status check. */
  const sourceChanges = ref<Record<string, number>>({})
  const loading = ref(false)

  const builtinCount = computed(() => resolved.value.filter((f) => f.tier === 'builtin').length)

  /** Probe the feature + load this board's tier, sources and resolved catalog. */
  async function probe() {
    if (!workspace.workspaceId) return
    const id = workspace.requireId()
    try {
      const [tier, srcs, merged] = await Promise.all([
        api.listFragments('workspace', id),
        api.listFragmentSources('workspace', id).catch(() => [] as FragmentSource[]),
        api.getResolvedFragments(id),
      ])
      fragments.value = tier
      sources.value = srcs
      resolved.value = merged
      available.value = true
    } catch {
      available.value = false
      fragments.value = []
      sources.value = []
      resolved.value = []
    }
  }

  async function refreshResolved() {
    resolved.value = await api.getResolvedFragments(workspace.requireId())
  }

  async function create(input: CreatePromptFragmentInput) {
    loading.value = true
    try {
      await api.createFragment('workspace', workspace.requireId(), input)
      await Promise.all([reloadTier(), refreshResolved()])
    } finally {
      loading.value = false
    }
  }

  async function update(fragmentId: string, patch: UpdatePromptFragmentInput) {
    await api.updateFragment('workspace', workspace.requireId(), fragmentId, patch)
    await Promise.all([reloadTier(), refreshResolved()])
  }

  /** Tombstone a fragment at the workspace tier (suppresses an inherited one). */
  async function remove(fragmentId: string) {
    await api.deleteFragment('workspace', workspace.requireId(), fragmentId)
    await Promise.all([reloadTier(), refreshResolved()])
  }

  async function reloadTier() {
    fragments.value = await api.listFragments('workspace', workspace.requireId())
  }

  async function linkSource(input: LinkFragmentSourceInput) {
    const source = await api.linkFragmentSource('workspace', workspace.requireId(), input)
    sources.value = [source, ...sources.value]
    return source
  }

  async function unlinkSource(sourceId: string) {
    await api.unlinkFragmentSource('workspace', workspace.requireId(), sourceId)
    sources.value = sources.value.filter((s) => s.id !== sourceId)
    await refreshResolved()
  }

  /** Resync a source's Markdown into the catalog, then refresh views. */
  async function syncSource(sourceId: string) {
    loading.value = true
    try {
      const result = await api.syncFragmentSource('workspace', workspace.requireId(), sourceId)
      delete sourceChanges.value[sourceId]
      await Promise.all([reloadSources(), refreshResolved()])
      return result
    } finally {
      loading.value = false
    }
  }

  /** Cheap "check for changes" for a source; caches the changed count. */
  async function checkSource(sourceId: string) {
    const status = await api.fragmentSourceStatus('workspace', workspace.requireId(), sourceId)
    sourceChanges.value = {
      ...sourceChanges.value,
      [sourceId]: status.changed ? status.changedCount : 0,
    }
    return status
  }

  async function reloadSources() {
    sources.value = await api.listFragmentSources('workspace', workspace.requireId())
  }

  return {
    available,
    fragments,
    resolved,
    sources,
    sourceChanges,
    loading,
    builtinCount,
    probe,
    refreshResolved,
    create,
    update,
    remove,
    linkSource,
    unlinkSource,
    syncSource,
    checkSource,
  }
})
