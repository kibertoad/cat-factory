import * as v from 'valibot'

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
  createdAt: v.number(),
})
export type ModelPreset = v.InferOutput<typeof modelPresetSchema>

// ---- Request bodies -------------------------------------------------------

const presetNameSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(60))
const modelIdSchema = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))
// Overrides: agent kinds are an open set (custom agents are allowed), so keys aren't
// checked against a closed list; both keys and values are trimmed non-empty strings.
const overridesSchema = v.record(v.pipe(v.string(), v.trim(), v.minLength(1)), modelIdSchema)

/** Create a new model preset in a workspace. */
export const createModelPresetSchema = v.object({
  name: presetNameSchema,
  baseModelId: modelIdSchema,
  overrides: v.optional(overridesSchema, {}),
  /** Make this the workspace default (demotes the previous default). */
  isDefault: v.optional(v.boolean(), false),
})
export type CreateModelPresetInput = v.InferOutput<typeof createModelPresetSchema>

/** Patch an existing model preset (all fields optional; `overrides` replaces the map). */
export const updateModelPresetSchema = v.object({
  name: v.optional(presetNameSchema),
  baseModelId: v.optional(modelIdSchema),
  overrides: v.optional(overridesSchema),
  isDefault: v.optional(v.boolean()),
})
export type UpdateModelPresetInput = v.InferOutput<typeof updateModelPresetSchema>
