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

/**
 * The catalog fields this join reads. `ListPublicWiredModelsResponseModel` satisfies it.
 *
 * Every field the verdict branches on is listed, `policyBlocked` included. A field left off here is
 * not a field the join ignores, it is one the join silently reads as absent on a row that carries
 * it: leaving `policyBlocked` out ranked a policy-refused model as having no provider, which is the
 * one cause whose fix is neither a key nor a token.
 */
export type ModelRow = {
  modelId: string
  available: boolean
  policyBlocked?: boolean
  personalSubscription?: boolean
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
 * How a preset's base model stands with this deployment AND this token. Five states, because they
 * take five different actions, and collapsing any pair of them sends an operator to a screen that
 * is already correct.
 *
 * A `personalSubscription` model is authenticated by a credential that belongs to a PERSON, and a
 * system token resolves no person, so the catalog reports it unavailable without dispatching being
 * what is wrong. Told it is `unwired`, an operator adds a provider key for a model their own
 * subscription already runs; told every unavailable model belongs to a person (which is what
 * deriving this from a whole-response flag amounts to), they are sent to re-mint a token for a
 * model that genuinely has no provider. Only the row can tell those apart, and only because the row
 * answers about an INDIVIDUAL-usage vendor: a workspace-pooled subscription is visible to every
 * key, so ranking it here would invent a token problem where there is none.
 *
 * `bindable` is what the row can now say that it could not before: the subscription EXISTS for the
 * person this key belongs to, resolved without unsealing it, and the token is simply not bound to
 * spend it. That is the difference between a diagnosis and an instruction: it is the answer the
 * first operator to hit this reached by re-minting the token to see what happened.
 *
 * `blocked` is the one state that is not about a credential at all. The model is CONFIGURED and the
 * account's model-family policy refuses it, so every other remedy this file can offer (a key, a
 * pooled token, a re-minted key) changes nothing. It ranks ahead of the credential states because a
 * policy refusal survives all of them.
 */
export type PresetAvailability =
  | 'selectable'
  | 'blocked'
  | 'bindable'
  | 'unsubscribed'
  | 'unjudged'
  | 'unwired'

/**
 * Whether a state says the model runs on somebody's PERSONAL credential that this token might yet
 * be able to reach.
 *
 * `unsubscribed` is deliberately NOT one of them, and the exclusion is the whole point of keeping it
 * apart from `unjudged`. It is the deployment's own answer that the owner holds NO subscription for
 * the vendor, so binding a token to that person changes nothing: treating it as reachable
 * preselected a preset certain to be refused at the first dispatch, over one that runs.
 */
export function isPersonalCredentialState(state: PresetAvailability): boolean {
  return state === 'bindable' || state === 'unjudged'
}

/**
 * The preset a pass is PINNED to, with the catalog row its base model resolves to, or `null` when
 * either is missing.
 *
 * Generic in both rows so the caller keeps the fields this join does not read. The up-front unlock
 * names the model and its provider to the operator, and narrowing the return to
 * `PresetRow`/`ModelRow` would send it back to re-find what this already found.
 */
export function pinnedModel<P extends PresetRow, M extends ModelRow>(
  presets: readonly P[],
  models: readonly M[],
  presetId: string,
): { preset: P; model: M } | null {
  const preset = presets.find((row) => row.presetId === presetId)
  const model = preset ? models.find((row) => row.modelId === preset.baseModelId) : undefined
  return preset && model ? { preset, model } : null
}

/** Whether a pass on the pinned preset will be asked for the operator's PERSONAL password. */
export type PersonalPasswordNeed = 'needed' | 'not-needed' | 'unknown'

/**
 * That question, answered from the catalog row alone.
 *
 * THREE answers, and `unknown` is the one worth having: a catalog that could not be read and a model
 * that needs no password are opposite facts, the same distinction {@link selectableModelIds} keeps
 * for the same reason. `unknown` means ASK LATER, which is exactly the behaviour that existed before
 * anything asked early, so a deployment this cannot reach loses nothing.
 *
 * The signal is `personalSubscription` ALONE, never `available`. A selectable personal-subscription
 * model is the case that produced this: the catalog reports the model dispatchable for this token and
 * the dispatch still answers `428`, because what opens the credential is the password. Reading
 * `available` here would ask for nothing in precisely the pass that needs it.
 */
export function personalPasswordNeed(pinned: { model: ModelRow } | null): PersonalPasswordNeed {
  if (!pinned) return 'unknown'
  return pinned.model.personalSubscription === true ? 'needed' : 'not-needed'
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
    // FIRST among the unavailable causes, because it outranks every other one the row can carry: a
    // model whose family the policy refuses stays refused for a token bound to whoever owns the
    // subscription that would otherwise have run it.
    if (model.policyBlocked === true) return 'blocked'
    if (model.personalSubscription !== true) return 'unwired'
    // Three ways a personal-credential row can be unavailable, kept apart because `null` is not
    // `false`: the deployment answered "there is one" / "there is none" / "there was nobody to ask".
    if (model.subscriptionConfigured === true) return 'bindable'
    return model.subscriptionConfigured === false ? 'unsubscribed' : 'unjudged'
  }
}
