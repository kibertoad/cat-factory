import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Per-workspace, per-agent-kind generation settings.
//
// A deployment routes every agent kind to a model with generation settings
// (`AGENT_ROUTING` / `AGENT_MODELS`), and the output-token ceiling in there is a
// DEPLOYMENT fact an operator sets once. But the right ceiling is a property of the
// work a kind does — a kind whose whole deliverable is one reply (a research brief, an
// outline, a review verdict) needs a budget the artifact actually fits in, and that is a
// judgement the workspace authoring the pipelines is best placed to make.
//
// So this is the workspace tier of the same knob, edited from the pipeline builder where
// the kinds are actually chosen — exactly like the per-workspace system-prompt overrides
// it sits beside (see ./agent-prompts.ts). Unlike prompts there is no revision log: a
// numeric ceiling has no history worth restoring and no two-editor text to clobber, so
// it is a plain per-kind row.
//
// A kind with NO row inherits the deployment routing default. `maxOutputTokens: null` is
// the same thing said explicitly, which is what lets the settings UI show "inheriting"
// as a state rather than having to delete the row to express it.
//
// Precedence at dispatch (widest to narrowest), resolved once by the engine:
//   deployment routing (env)  <  this workspace row  <  the pipeline step's own option
// The per-step value lives on `StepOptions.maxOutputTokens` (entities.ts) so a single
// pipeline can deviate without moving the workspace-wide default.
// ---------------------------------------------------------------------------

/**
 * Floor on a configured output ceiling. Low enough for a deliberately terse classifier,
 * high enough that a value below it is a typo rather than an intent — under a couple of
 * hundred tokens a reasoning model's `<think>` alone exhausts the budget and every reply
 * comes back empty, which reads as a broken kind rather than a misconfigured one.
 */
export const MIN_AGENT_MAX_OUTPUT_TOKENS = 256

/**
 * Ceiling on a configured output ceiling. Deliberately above any current model's real
 * output limit: this bound exists to catch a fat-fingered extra digit, not to encode a
 * per-model capability the catalog would have to keep in step. A value a model cannot
 * serve is rejected by the provider with its own clear error.
 */
export const MAX_AGENT_MAX_OUTPUT_TOKENS = 200_000

/** The bounded output-token ceiling, shared by this tier and the per-step option. */
export const agentMaxOutputTokensSchema = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(MIN_AGENT_MAX_OUTPUT_TOKENS),
  v.maxValue(MAX_AGENT_MAX_OUTPUT_TOKENS),
)

/**
 * One agent kind's generation settings in a workspace. Sparse by design — a kind is
 * absent from the store until someone sets something, and every field is nullable so a
 * future knob can be added without inventing a sentinel for "not set".
 */
export const workspaceAgentSettingsSchema = v.object({
  agentKind: v.string(),
  /**
   * The output-token ceiling for this kind's inline calls, or `null` to inherit the
   * deployment routing default. Applies where the cap is genuinely ENFORCED — the
   * metered provider path; on a subscription-CLI inline run the one-shot CLIs treat it
   * as advisory (see the harness's `InlineJob.maxOutputTokens`), so raising it there
   * changes nothing and lowering it does not constrain spend.
   */
  maxOutputTokens: v.nullable(agentMaxOutputTokensSchema),
  updatedAt: v.number(),
})
export type WorkspaceAgentSettings = v.InferOutput<typeof workspaceAgentSettingsSchema>

// ---- Request bodies -------------------------------------------------------

/**
 * Set (or clear) one kind's settings. An explicit `null` clears the override back to the
 * deployment default; omitting the field leaves it untouched, so a future second knob can
 * be written without a read-modify-write race against this one.
 */
export const updateWorkspaceAgentSettingsSchema = v.object({
  maxOutputTokens: v.optional(v.nullable(agentMaxOutputTokensSchema)),
})
export type UpdateWorkspaceAgentSettingsInput = v.InferOutput<
  typeof updateWorkspaceAgentSettingsSchema
>
