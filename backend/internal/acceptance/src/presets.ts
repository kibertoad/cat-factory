// The one join between the preset library and the model catalog: which presets can be dispatched to.
//
// Two commands state this to the same operator. `configure` offers the library as a menu and marks
// the rows nothing is wired for; the `model-preset` prerequisite refuses a pinned preset and offers
// the alternatives. The whole point of those two agreeing is that the menu never offers what the
// gate will refuse, so the judgement lives here once rather than as the same `new Set(...)` in both.
//
// Typed structurally rather than against the SDK's row types, because `ConfigureClient` narrows both
// reads to the fields it needs and the judgement does not depend on the rest.

/** The preset fields this join reads. `ListPublicModelPresetsResponsePreset` satisfies it. */
export type PresetRow = { presetId: string; name: string; baseModelId: string }

/** The catalog fields this join reads. `ListPublicWiredModelsResponseModel` satisfies it. */
export type ModelRow = { modelId: string; available: boolean }

/**
 * The model ids this deployment can dispatch to right now.
 *
 * Note what it does NOT say: a catalog that could not be READ is an empty set here, which is why
 * both callers keep "we could not check" apart from "nothing is wired" before they get this far.
 * Those are opposite facts, and only the second should stop an operator picking a preset.
 */
export function selectableModelIds(models: readonly ModelRow[]): ReadonlySet<string> {
  return new Set(models.filter((model) => model.available).map((model) => model.modelId))
}

/** The presets whose base model is selectable, in library order. */
export function usablePresets<T extends PresetRow>(
  presets: readonly T[],
  models: readonly ModelRow[],
): readonly T[] {
  const selectable = selectableModelIds(models)
  return presets.filter((preset) => selectable.has(preset.baseModelId))
}
