/**
 * Kaizen-grader readiness for the active workspace. Kaizen grades each agent step after a run
 * through an INLINE LLM call, so, like the requirements reviewer, its model must be
 * inline-runnable. A workspace whose Kaizen model resolves to a subscription-only model this
 * deployment can't run inline can't grade at all: the backend skips those
 * runs instead of failing on the degraded routing default, and this composable drives the banner
 * that steers the user to a compatible model.
 *
 *  - `enabled`: is the Kaizen agent turned on for this workspace?
 *  - `modelUnfit`: Kaizen is on and the model it would grade with is usable, but can't drive the
 *    inline grader (the banner). `AiProvidersBanner` owns both "no AI configured at all" and "the
 *    default preset names an unusable model", so this one fires only for the subscription-only
 *    case. Gated on the default preset having loaded so it does not flash while the presets are
 *    still in flight.
 *
 * Read-only over the existing stores (settings, presets and the per-workspace model catalog, whose
 * `inlineUsable` flag the backend computes with the deployment's inline-harness seam). It reads
 * the workspace DEFAULT preset, so a task that selects another preset or pins its own model can
 * still be skipped or graded differently by the backend; the banner covers the common case.
 */
export function useKaizenReadiness() {
  const models = useModelsStore()
  const modelPresets = useModelPresetsStore()
  const settings = useWorkspaceSettingsStore()
  /** The per-workspace catalog has loaded for the workspace currently open. */
  const { ready } = useAiReadiness()

  const enabled = computed(() => settings.settings.kaizenEnabled)

  /** The catalog model id the grader resolves to under the workspace DEFAULT preset. */
  const modelId = computed(() => modelPresets.modelForKind(modelPresets.defaultPreset, 'kaizen'))

  const model = computed(() => models.getModel(modelId.value))

  /**
   * Kaizen is on and its model is usable, but it can't run the inline grader. An UNUSABLE model
   * is left to `AiProvidersBanner`'s preset-mismatch prompt, which already names it, so the two
   * banners never stack over one cause.
   */
  const modelUnfit = computed(
    () =>
      ready.value &&
      enabled.value &&
      models.hasUsableModel &&
      modelPresets.defaultPreset != null &&
      model.value?.available === true &&
      model.value.inlineUsable === false,
  )

  return { ready, enabled, modelId, model, modelUnfit }
}
