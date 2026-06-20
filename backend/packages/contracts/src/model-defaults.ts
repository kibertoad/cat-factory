import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-workspace, per-agent-kind default model selection. A workspace can choose
// which model is the default for each agent kind (e.g. point `architect` at a
// strong model and `tester` at a cheap one), overriding the env-driven
// `AGENT_routing` for that workspace at runtime. The map is keyed by agent kind
// and valued by a model catalog id (the `ModelOption.id` from `GET /models`).
//
// Resolution precedence at run time is: a block's explicitly pinned model wins,
// else this workspace per-kind default, else the env routing for the kind, else
// the env default. So this map only fills the gap between "no per-task pin" and
// "the deployment-wide routing".
// ---------------------------------------------------------------------------

/**
 * A workspace's per-agent-kind default models: a map from agent kind to the model
 * catalog id it should default to. A kind absent from the map falls back to the
 * env routing for that kind. Sent on the wire as the workspace's full selection.
 */
export const modelDefaultsSchema = v.object({
  defaults: v.record(v.string(), v.string()),
})
export type ModelDefaults = v.InferOutput<typeof modelDefaultsSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Replace a workspace's per-kind default models. Sending the full map replaces it
 * wholesale (a kind omitted is cleared). Each value is a trimmed, non-empty model id.
 */
export const setModelDefaultsSchema = v.object({
  defaults: v.record(v.string(), v.pipe(v.string(), v.trim(), v.minLength(1))),
})
export type SetModelDefaultsInput = v.InferOutput<typeof setModelDefaultsSchema>
