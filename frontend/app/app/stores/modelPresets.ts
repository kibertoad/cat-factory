import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  CreateModelPresetInput,
  ModelPreset,
  UpdateModelPresetInput,
} from '~/types/model-presets'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The workspace's model presets — the library a task picks its model→agent mapping
 * from (each preset is a base model applied to every agent kind plus per-kind
 * overrides). Hydrated from the workspace snapshot; managed via the Model Configuration
 * settings screen. The backend always keeps at least one default preset (the built-in
 * "Kimi K2.7", everything Kimi).
 */
export const useModelPresetsStore = defineStore('modelPresets', () => {
  const api = useApi()

  const presets = ref<ModelPreset[]>([])
  /**
   * Current built-in catalog versions (`seedModelPresets()`), keyed by preset id, from the
   * workspace snapshot. The keys ARE the set of built-in ids: a stored preset whose id is a
   * key here is a built-in (and is outdated when its `version` is below the catalog value),
   * and a key with no matching stored preset is a NEW built-in the workspace can add. Drives
   * `useModelPresetHealth`.
   */
  const catalogVersions = ref<Record<string, number>>({})

  function hydrate(list: ModelPreset[], versions?: Record<string, number>) {
    presets.value = [...list].sort((a, b) => a.createdAt - b.createdAt)
    if (versions) catalogVersions.value = versions
  }

  /** The workspace default (fallback for a task that picks none). */
  const defaultPreset = computed(() => presets.value.find((p) => p.isDefault) ?? null)

  /** Resolve a task's effective preset by id, falling back to the default. */
  function resolve(presetId: string | undefined): ModelPreset | null {
    if (presetId) {
      const picked = presets.value.find((p) => p.id === presetId)
      if (picked) return picked
    }
    return defaultPreset.value
  }

  /** The model id a preset assigns to an agent kind (`overrides[kind] ?? baseModelId`). */
  function modelForKind(preset: ModelPreset | null, agentKind: string): string | undefined {
    if (!preset) return undefined
    return preset.overrides[agentKind] ?? preset.baseModelId
  }

  async function create(input: CreateModelPresetInput) {
    const ws = useWorkspaceStore()
    const created = await api.createModelPreset(ws.requireId(), input)
    await ws.refresh()
    return created
  }

  async function update(presetId: string, patch: UpdateModelPresetInput) {
    const ws = useWorkspaceStore()
    const updated = await api.updateModelPreset(ws.requireId(), presetId, patch)
    await ws.refresh()
    return updated
  }

  async function remove(presetId: string) {
    const ws = useWorkspaceStore()
    await api.deleteModelPreset(ws.requireId(), presetId)
    await ws.refresh()
  }

  /**
   * Reseed a built-in preset from the backend's current catalog: adopt an updated definition,
   * repair a drifted one, or materialise a NEW built-in that appeared after the workspace was
   * created. The `presetId` is the catalog id (e.g. `mdp_kimi`). Refreshes the snapshot.
   */
  async function reseed(presetId: string) {
    const ws = useWorkspaceStore()
    const updated = await api.reseedModelPreset(ws.requireId(), presetId)
    await ws.refresh()
    return updated
  }

  return {
    presets,
    catalogVersions,
    defaultPreset,
    resolve,
    modelForKind,
    hydrate,
    create,
    update,
    remove,
    reseed,
  }
})
