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
export type ModelRow = {
  modelId: string
  available: boolean
  userScoped?: boolean
  subscriptionConfigured?: boolean | null
}

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

/**
 * How a preset's base model stands with this deployment AND this token. Four states, because they
 * take four different actions, and collapsing any pair of them sends an operator to a screen that
 * is already correct.
 *
 * A `userScoped` model is authenticated by a credential that belongs to a PERSON, and a system
 * token resolves no person, so the catalog reports it unavailable without dispatching being what is
 * wrong. Told it is `unwired`, an operator adds a provider key for a model their own subscription
 * already runs; told every unavailable model is user-scoped (which is what deriving this from a
 * whole-response flag amounts to), they are sent to re-mint a token for a model that genuinely has
 * no provider. Only the row can tell those apart.
 *
 * `bindable` is what the row can now say that it could not before: the subscription EXISTS for the
 * person this key belongs to, resolved without unsealing it, and the token is simply not bound to
 * spend it. That is the difference between a diagnosis and an instruction — it is the answer the
 * first operator to hit this reached by re-minting the token to see what happened.
 */
export type PresetAvailability = 'selectable' | 'bindable' | 'unsubscribed' | 'unjudged' | 'unwired'

/** Whether a state says the model runs on somebody's PERSONAL credential rather than a wired key. */
export function isPersonalCredentialState(state: PresetAvailability): boolean {
  return state === 'bindable' || state === 'unsubscribed' || state === 'unjudged'
}

/**
 * Build the per-preset verdict once, then ask it per row: the sets are computed a single time
 * rather than per preset, so a 40-preset menu does not rebuild them 40 times.
 */
export function presetAvailability(
  models: readonly ModelRow[],
): (preset: PresetRow) => PresetAvailability {
  const byId = new Map(models.map((model) => [model.modelId, model]))
  return (preset) => {
    const model = byId.get(preset.baseModelId)
    // An id the catalog does not carry at all is `unwired` here: `model-preset` reports the missing
    // entry itself, with the catalog listed, and this join is only asked to rank what it can see.
    if (!model) return 'unwired'
    if (model.available) return 'selectable'
    if (model.userScoped !== true) return 'unwired'
    // Three ways a user-scoped row can be unavailable, kept apart because `null` is not `false`:
    // the deployment answered "there is one" / "there is none" / "there was nobody to ask about".
    if (model.subscriptionConfigured === true) return 'bindable'
    return model.subscriptionConfigured === false ? 'unsubscribed' : 'unjudged'
  }
}
