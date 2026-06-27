import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { MergeThresholdPreset, UpdateMergePresetInput } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's merge threshold presets — the library a task picks its
 * auto-merge policy from (the `merger` step compares the PR assessment against the
 * resolved preset). Hydrated from the workspace snapshot; managed via a small
 * settings UI. The backend always keeps at least one default preset.
 */
export const useMergePresetsStore = defineStore('mergePresets', () => {
  const api = useApi()

  const presets = ref<MergeThresholdPreset[]>([])

  function hydrate(list: MergeThresholdPreset[]) {
    presets.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The workspace default (fallback for a task that picks none). */
  const defaultPreset = computed(() => presets.value.find((p) => p.isDefault) ?? null)

  /** Resolve a task's effective preset by id, falling back to the default. */
  function resolve(presetId: string | undefined): MergeThresholdPreset | null {
    if (presetId) {
      const picked = presets.value.find((p) => p.id === presetId)
      if (picked) return picked
    }
    return defaultPreset.value
  }

  async function create(input: Parameters<typeof api.createMergePreset>[1]) {
    const ws = useWorkspaceStore()
    const created = await api.createMergePreset(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(presetId: string, patch: UpdateMergePresetInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateMergePreset(ws.requireId(), presetId, patch)
    await ws.refresh()
    return updated
  }

  async function remove(presetId: string) {
    const ws = useWorkspaceStore()
    await api.deleteMergePreset(ws.requireId(), presetId)
    await ws.refresh()
  }

  return { presets, defaultPreset, resolve, hydrate, create, update, remove }
})
