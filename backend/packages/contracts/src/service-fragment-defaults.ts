import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-workspace default set of best-practice prompt fragments for NEW services.
// When a service (frame block) is created in the workspace, its
// `serviceFragmentIds` are seeded from this list. Changing the default does not
// retroactively change existing services — each service owns its selection from
// then on. The ids reference the universal fragment pool (built-in catalog plus
// any deployment-registered fragments, served by GET /prompt-fragments).
// ---------------------------------------------------------------------------

/** A workspace's default service-fragment selection: the ids new services inherit. */
export const serviceFragmentDefaultsSchema = v.object({
  fragmentIds: v.array(v.string()),
})
export type ServiceFragmentDefaults = v.InferOutput<typeof serviceFragmentDefaultsSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Replace a workspace's default service-fragment selection wholesale. Ids are trimmed
 * and must be non-empty; they are not validated against the catalog here (an
 * unresolvable id is simply skipped when bodies are resolved at run time).
 */
export const setServiceFragmentDefaultsSchema = v.object({
  fragmentIds: v.array(v.pipe(v.string(), v.trim(), v.minLength(1))),
})
export type SetServiceFragmentDefaultsInput = v.InferOutput<typeof setServiceFragmentDefaultsSchema>
