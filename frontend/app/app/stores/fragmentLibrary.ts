import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreateDocumentFragmentInput,
  CreatePromptFragmentInput,
  FragmentOwnerKind,
  FragmentSource,
  LinkFragmentSourceInput,
  PromptFragment,
  ResolvedFragment,
  UpdatePromptFragmentInput,
} from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Prompt-fragment library state (ADR 0006), scoped to a single owner — a board
 * (`workspace`) or an account. Holds that owner's own (raw) tier fragments, its
 * linked guideline repos, and — for the **workspace** tier only — the merged
 * catalog an agent actually sees (built-in ∪ account ∪ workspace). `available`
 * mirrors the backend's opt-in gate: a 503 from the probe means the feature is off
 * and the UI hides its entry.
 *
 * Two entry points share this setup: `useFragmentLibraryStore` (the workspace
 * singleton that follows the active board, used by the navbar + the board modal)
 * and `useFragmentLibrary(kind, ownerId)` (an owner-keyed store, used for the
 * account tier). The account tier has no resolved/merged catalog and, for
 * document-backed fragments, needs a `viaWorkspaceId` (document-source credentials
 * are per-workspace).
 */
function fragmentLibrarySetup(kind: FragmentOwnerKind, resolveOwnerId: () => string | null) {
  const api = useApi()

  /** The merged/resolved catalog only exists at the workspace tier. */
  const hasResolved = kind === 'workspace'

  /** null = not probed yet; true/false = library on/off. */
  const available = ref<boolean | null>(null)
  /** This owner's hand-authored + sourced fragments (its own tier, raw). */
  const fragments = ref<PromptFragment[]>([])
  /** The merged catalog an agent sees (workspace tier only; empty otherwise). */
  const resolved = ref<ResolvedFragment[]>([])
  /** Linked guideline repos for this owner. */
  const sources = ref<FragmentSource[]>([])
  /** Per-source "changes available" counts from the last status check. */
  const sourceChanges = ref<Record<string, number>>({})
  const loading = ref(false)
  /**
   * Account-tier document fragments only: the workspace whose stored
   * document-source connection is used to fetch/refresh the page (credentials are
   * per-workspace). Set by the caller; ignored at the workspace scope (the owner
   * board is used directly).
   */
  const viaWorkspaceId = ref<string | undefined>(undefined)

  const builtinCount = computed(() => resolved.value.filter((f) => f.tier === 'builtin').length)

  function requireOwnerId(): string {
    const id = resolveOwnerId()
    if (!id) throw new Error('No fragment-library owner')
    return id
  }

  /** Probe the feature + load this owner's tier, sources and (ws) resolved catalog. */
  async function probe() {
    const id = resolveOwnerId()
    if (!id) return
    try {
      const [tier, srcs, merged] = await Promise.all([
        api.listFragments(kind, id),
        api.listFragmentSources(kind, id).catch(() => [] as FragmentSource[]),
        hasResolved ? api.getResolvedFragments(id) : Promise.resolve([] as ResolvedFragment[]),
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
    if (!hasResolved) return
    resolved.value = await api.getResolvedFragments(requireOwnerId())
  }

  async function create(input: CreatePromptFragmentInput) {
    loading.value = true
    try {
      await api.createFragment(kind, requireOwnerId(), input)
      await Promise.all([reloadTier(), refreshResolved()])
    } finally {
      loading.value = false
    }
  }

  async function update(fragmentId: string, patch: UpdatePromptFragmentInput) {
    await api.updateFragment(kind, requireOwnerId(), fragmentId, patch)
    await Promise.all([reloadTier(), refreshResolved()])
  }

  /** Link an external document as a living (dynamically-resolved) fragment. */
  async function createDocumentFragment(input: CreateDocumentFragmentInput) {
    loading.value = true
    try {
      await api.createDocumentFragment(kind, requireOwnerId(), {
        ...input,
        ...(viaWorkspaceId.value ? { viaWorkspaceId: viaWorkspaceId.value } : {}),
      })
      await Promise.all([reloadTier(), refreshResolved()])
    } finally {
      loading.value = false
    }
  }

  /** Force an immediate live re-resolve of a document-backed fragment. */
  async function refreshDocumentFragment(fragmentId: string) {
    loading.value = true
    try {
      await api.refreshFragment(kind, requireOwnerId(), fragmentId, viaWorkspaceId.value)
      await Promise.all([reloadTier(), refreshResolved()])
    } finally {
      loading.value = false
    }
  }

  /** Tombstone a fragment at this tier (suppresses an inherited one). */
  async function remove(fragmentId: string) {
    await api.deleteFragment(kind, requireOwnerId(), fragmentId)
    await Promise.all([reloadTier(), refreshResolved()])
  }

  async function reloadTier() {
    fragments.value = await api.listFragments(kind, requireOwnerId())
  }

  async function linkSource(input: LinkFragmentSourceInput) {
    const source = await api.linkFragmentSource(kind, requireOwnerId(), input)
    sources.value = [source, ...sources.value]
    return source
  }

  async function unlinkSource(sourceId: string) {
    await api.unlinkFragmentSource(kind, requireOwnerId(), sourceId)
    sources.value = sources.value.filter((s) => s.id !== sourceId)
    await refreshResolved()
  }

  /** Resync a source's Markdown into the catalog, then refresh views. */
  async function syncSource(sourceId: string) {
    loading.value = true
    try {
      const result = await api.syncFragmentSource(kind, requireOwnerId(), sourceId)
      delete sourceChanges.value[sourceId]
      await Promise.all([reloadSources(), refreshResolved()])
      return result
    } finally {
      loading.value = false
    }
  }

  /** Cheap "check for changes" for a source; caches the changed count. */
  async function checkSource(sourceId: string) {
    const status = await api.fragmentSourceStatus(kind, requireOwnerId(), sourceId)
    sourceChanges.value = {
      ...sourceChanges.value,
      [sourceId]: status.changed ? status.changedCount : 0,
    }
    return status
  }

  async function reloadSources() {
    sources.value = await api.listFragmentSources(kind, requireOwnerId())
  }

  return {
    kind,
    hasResolved,
    available,
    fragments,
    resolved,
    sources,
    sourceChanges,
    loading,
    viaWorkspaceId,
    builtinCount,
    probe,
    refreshResolved,
    create,
    createDocumentFragment,
    refreshDocumentFragment,
    update,
    remove,
    linkSource,
    unlinkSource,
    syncSource,
    checkSource,
  }
}

/**
 * The workspace-tier library for the **active** board — a singleton that resolves
 * the owner lazily, so it follows board switches and is shared by the navbar
 * (SideBar/CommandBar probes) and the board fragment modal.
 */
export const useFragmentLibraryStore = defineStore('fragmentLibrary', () =>
  fragmentLibrarySetup('workspace', () => useWorkspaceStore().workspaceId),
)

/**
 * An owner-keyed library store, used for the **account** tier (and reusable for any
 * explicit owner). Keyed by `(kind, ownerId)` so each account gets isolated state.
 */
export function useFragmentLibrary(kind: FragmentOwnerKind, ownerId: string) {
  return defineStore(`fragmentLibrary:${kind}:${ownerId}`, () =>
    fragmentLibrarySetup(kind, () => ownerId),
  )()
}
