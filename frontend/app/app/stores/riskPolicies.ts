import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { RiskPolicy, UpdateRiskPolicyInput } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's merge threshold presets — the library a task picks its
 * auto-merge policy from (the `merger` step compares the PR assessment against the
 * resolved preset). Hydrated from the workspace snapshot; managed via a small
 * settings UI. The backend always keeps at least one default preset.
 */
export const useRiskPoliciesStore = defineStore('riskPolicies', () => {
  const api = useApi()

  const presets = ref<RiskPolicy[]>([])
  /**
   * Current built-in catalog versions (`seedRiskPolicies()`), keyed by preset id, from the
   * workspace snapshot. The keys ARE the set of built-in ids: a stored preset whose id is a
   * key here is a built-in (and is outdated when its `version` is below the catalog value),
   * and a key with no matching stored preset is a NEW built-in the workspace can add. Drives
   * `useRiskPolicyHealth`.
   */
  const catalogVersions = ref<Record<string, number>>({})

  function hydrate(list: RiskPolicy[], versions?: Record<string, number>) {
    presets.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
    if (versions) catalogVersions.value = versions
  }

  /** The workspace default (fallback for a task that picks none). */
  const defaultPreset = computed(() => presets.value.find((p) => p.isDefault) ?? null)

  /** Resolve a task's effective preset by id, falling back to the default. */
  function resolve(presetId: string | undefined): RiskPolicy | null {
    if (presetId) {
      const picked = presets.value.find((p) => p.id === presetId)
      if (picked) return picked
    }
    return defaultPreset.value
  }

  async function create(input: Parameters<typeof api.createRiskPolicy>[1]) {
    const ws = useWorkspaceStore()
    const created = await api.createRiskPolicy(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(presetId: string, patch: UpdateRiskPolicyInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateRiskPolicy(ws.requireId(), presetId, patch)
    await ws.refresh()
    return updated
  }

  async function remove(presetId: string) {
    const ws = useWorkspaceStore()
    await api.deleteRiskPolicy(ws.requireId(), presetId)
    await ws.refresh()
  }

  /**
   * Reseed a built-in preset from the backend's current catalog: adopt an updated definition,
   * repair a drifted one, or materialise a NEW built-in that appeared after the workspace was
   * created. The `presetId` is the catalog id (e.g. `mp_balanced`). Refreshes the snapshot.
   */
  async function reseed(presetId: string) {
    const ws = useWorkspaceStore()
    const updated = await api.reseedRiskPolicy(ws.requireId(), presetId)
    await ws.refresh()
    return updated
  }

  return {
    presets,
    catalogVersions,
    defaultPreset,
    resolve,
    hydrate,
    create,
    update,
    remove,
    reseed,
  }
})
