/**
 * Kaizen-grader readiness for the active workspace. Kaizen grades each agent step after a
 * run via an INLINE LLM call, so — like the requirements reviewer — its model must be
 * inline-runnable. A workspace whose Kaizen model resolves to a subscription-only model this
 * deployment can't run inline (or to nothing configured) can't grade at all: the backend skips
 * those runs instead of failing on the degraded routing default, and this composable drives the
 * banner that steers the user to a compatible model.
 *
 *  - `enabled` — is the Kaizen agent turned on for this workspace?
 *  - `modelUnfit` — Kaizen is on, the workspace HAS usable AI, but the model it would grade with
 *    can't drive the inline grader (⇒ the banner). Gated on `hasUsableModel` so the broader
 *    "no AI configured at all" prompt (`AiProvidersBanner`) owns that case on its own.
 *
 * Read-only over the existing stores (settings + presets + the per-workspace model catalog,
 * whose `inlineUsable` flag the backend computes with the deployment's inline-harness seam).
 */
export function useKaizenReadiness() {
  const models = useModelsStore()
  const modelPresets = useModelPresetsStore()
  const settings = useWorkspaceSettingsStore()
  const workspace = useWorkspaceStore()

  /** The per-workspace catalog has loaded for the workspace currently open. */
  const ready = computed(
    () =>
      models.loaded &&
      workspace.workspaceId != null &&
      models.loadedWorkspaceId === workspace.workspaceId,
  )

  const enabled = computed(() => settings.settings.kaizenEnabled)

  /** The catalog model id the grader resolves to under the workspace DEFAULT preset. */
  const modelId = computed(() => modelPresets.modelForKind(modelPresets.defaultPreset, 'kaizen'))

  const model = computed(() => models.getModel(modelId.value))

  /**
   * Kaizen is on and there IS usable AI, but its model can't run the inline grader (a
   * subscription-only model with no inline harness, or one that isn't configured at all).
   */
  const modelUnfit = computed(
    () =>
      ready.value && enabled.value && models.hasUsableModel && model.value?.inlineUsable !== true,
  )

  return { ready, enabled, modelId, model, modelUnfit }
}
