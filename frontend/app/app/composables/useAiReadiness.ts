import type { ModelPreset } from '~/types/model-presets'

/**
 * AI-configuration readiness for the active workspace. cat-factory only ships a usable
 * AI model out of the box on a Cloudflare deployment with Workers AI enabled; every other
 * deployment needs the user to onboard at least one source (a provider key, a pooled /
 * personal subscription, a proxy, Bedrock, or a local runner). This composable turns the
 * per-workspace model catalog (whose `available` flag already reflects all of those) plus
 * the workspace's model presets into the two signals the onboarding surfaces consume:
 *
 *  - `hasUsableModel` — is ANY AI source configured at all? (false ⇒ the no-AI prompt)
 *  - `defaultPresetBroken` — the workspace has usable models, but its DEFAULT model preset
 *    still points at one or more that aren't usable (⇒ the preset-mismatch prompt). Gated on
 *    `hasUsableModel` so the no-AI prompt owns the "nothing works" case on its own.
 *
 * Read-only over the existing stores; the catalog is loaded elsewhere (on workspace-ready
 * and after credential edits), so `ready` simply reports whether that load has landed for
 * the active workspace.
 */
export function useAiReadiness() {
  const models = useModelsStore()
  const modelPresets = useModelPresetsStore()
  const workspace = useWorkspaceStore()

  /** The per-workspace catalog has loaded for the workspace currently open. */
  const ready = computed(
    () =>
      models.loaded &&
      workspace.workspaceId != null &&
      models.loadedWorkspaceId === workspace.workspaceId,
  )

  const hasUsableModel = computed(() => models.hasUsableModel)

  /** Every distinct catalog model id a preset assigns (base + overrides). */
  function presetModelIds(preset: ModelPreset | null): string[] {
    if (!preset) return []
    return [...new Set([preset.baseModelId, ...Object.values(preset.overrides)])]
  }

  /** The preset's assigned model ids that aren't usable under the current configuration. */
  function unavailableInPreset(preset: ModelPreset | null): string[] {
    return presetModelIds(preset).filter((id) => !models.isUsableId(id))
  }

  /** Unusable model ids in the workspace DEFAULT preset (what tasks fall back to). */
  const defaultPresetUnavailable = computed(() => unavailableInPreset(modelPresets.defaultPreset))

  /** Usable models exist, but the default preset still references unusable ones. */
  const defaultPresetBroken = computed(
    () => hasUsableModel.value && defaultPresetUnavailable.value.length > 0,
  )

  return {
    ready,
    hasUsableModel,
    presetModelIds,
    unavailableInPreset,
    defaultPresetUnavailable,
    defaultPresetBroken,
  }
}
