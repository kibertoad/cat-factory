import * as v from 'valibot'
import { modelFlavorSchema } from './entities.js'

// ---------------------------------------------------------------------------
// Model presets: a named, per-workspace set of model→agent mappings. A preset
// carries one `baseModelId` applied to EVERY agent kind, plus optional per-kind
// `overrides`. So "everything Kimi K2.7" is a preset with base `kimi-k2.7` and no
// overrides; tweaking a single agent (e.g. a stronger architect) adds one override
// without listing the rest.
//
// Presets are authored per workspace (a small library, e.g. "Kimi K2.7", "GLM-5.2")
// and one is the workspace default (`isDefault`). A task selects one via
// `Block.modelPresetId`; a task with no selection resolves to the default preset.
// Changing a task's preset takes effect on its NEXT step — steps already dispatched
// keep the model they started on.
//
// Resolution precedence at run time: a block's explicitly pinned model
// (`Block.modelId`) wins, else the task's selected/default preset's mapping for the
// kind (`overrides[kind] ?? baseModelId`), else the env-driven routing. So presets
// fill the gap between "no per-task pin" and "the deployment-wide routing".
// ---------------------------------------------------------------------------

/**
 * A named, per-workspace model preset: one `baseModelId` applied to every agent kind,
 * plus per-kind `overrides`. Exactly one preset per workspace is the default
 * (`isDefault`), used by any task that has not picked one explicitly. Model ids are
 * catalog ids (the `ModelOption.id` from `GET /models`); an unresolvable id falls
 * back to the env routing at run time.
 */
export const modelPresetSchema = v.object({
  id: v.string(),
  name: v.string(),
  /** The model every agent kind defaults to under this preset. */
  baseModelId: v.string(),
  /** Per-agent-kind model overrides on top of the base (agent kind → model id). */
  overrides: v.record(v.string(), v.string()),
  /** The workspace's fallback preset, used by tasks that pick none. Exactly one is true. */
  isDefault: v.boolean(),
  /**
   * Monotonic seed version for a BUILT-IN preset (`seedModelPresets()` assigns it). When the
   * current catalog version for this id exceeds the persisted copy's `version`, the SPA offers
   * to reseed it. Absent on user-created presets (not version-tracked) and on rows persisted
   * before versioning existed (treated as 0).
   */
  version: v.optional(v.number()),
  /**
   * The order this preset's runs prefer a model's routes in, most preferred first. A preference
   * REORDERS, it never filters: routes the list omits are appended in the default order and tried
   * last, so a preset naming three flavours cannot make a model whose only route is the fourth
   * unresolvable. Absent ⇒ the deployment's default order.
   *
   * Per PRESET rather than per deployment because it is a per-workload choice: the same workspace
   * legitimately wants a compliance preset pinned to a residency-guaranteed route (AWS Bedrock)
   * and an everyday preset riding a flat-rate subscription.
   */
  providerPreference: v.optional(v.array(modelFlavorSchema)),
  createdAt: v.number(),
})
export type ModelPreset = v.InferOutput<typeof modelPresetSchema>

// ---- Request bodies -------------------------------------------------------

const presetNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const modelIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
// Overrides: agent kinds are an open set (custom agents are allowed), so keys aren't
// checked against a closed list; both keys and values are trimmed non-empty strings.
const overridesSchema = v.record(v.pipe(v.string(), v.trim(), v.minLength(1)), modelIdSchema)
// The route preference is an ORDER, so a repeated flavour has no meaning: it would be ambiguous to
// read back in the editor and ambiguous to walk. Refused at the write boundary rather than
// silently deduped, since the caller stated two positions for one route and only they know which
// they meant. An EMPTY list is accepted and is how a preset goes back to the default order.
const providerPreferenceSchema = v.pipe(
  v.array(modelFlavorSchema),
  v.check(
    (flavors) => new Set(flavors).size === flavors.length,
    'providerPreference must not repeat a route',
  ),
)

/** Create a new model preset in a workspace. */
export const createModelPresetSchema = v.object({
  name: presetNameSchema,
  baseModelId: modelIdSchema,
  overrides: v.optional(overridesSchema, {}),
  /** Make this the workspace default (demotes the previous default). */
  isDefault: v.optional(v.boolean(), false),
  /** Route preference for this preset's runs; omitted/empty ⇒ the default order. */
  providerPreference: v.optional(providerPreferenceSchema),
})
export type CreateModelPresetInput = v.InferOutput<typeof createModelPresetSchema>

/** Patch an existing model preset (all fields optional; `overrides` replaces the map). */
export const updateModelPresetSchema = v.object({
  name: v.optional(presetNameSchema),
  baseModelId: v.optional(modelIdSchema),
  overrides: v.optional(overridesSchema),
  isDefault: v.optional(v.boolean()),
  /**
   * Replaces the whole order. An EMPTY array resets the preset to the default order, which is
   * why "reset" needs no separate route: absent means "leave it alone", `[]` means "clear it".
   */
  providerPreference: v.optional(providerPreferenceSchema),
})
export type UpdateModelPresetInput = v.InferOutput<typeof updateModelPresetSchema>
