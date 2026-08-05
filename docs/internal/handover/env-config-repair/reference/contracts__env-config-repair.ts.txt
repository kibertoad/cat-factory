import * as v from 'valibot'
import { agentFailureSchema, stepSubtasksSchema } from './entities.js'
import { repoValidationIssueSchema } from './provider-config.js'

// ---------------------------------------------------------------------------
// Environment-provider config-repair run (PR #416 increment 2). When mechanical
// config bootstrap can't produce a valid provider config and the caller opted in,
// the engine dispatches a coding agent that fixes the provider's config file in an
// EXISTING repo and pushes the fix back onto the same branch — then re-validates.
//
// Unlike a "bootstrap repo" run this has NO board block and NO service frame: it is
// surfaced only on the infrastructure-providers window that triggered it. It is a
// durable, asynchronous, observable run (its own `kind='env-config-repair'` row in
// the unified `agent_runs` table), driven exactly like a bootstrap run, so it never
// blocks the triggering request.
// ---------------------------------------------------------------------------

/** Lifecycle of a single environment-provider config-repair run. */
export const envConfigRepairStatusSchema = v.picklist(['running', 'succeeded', 'failed'])
export type EnvConfigRepairStatus = v.InferOutput<typeof envConfigRepairStatusSchema>

/** One environment-provider config-repair run, with its post-repair validation. */
export const envConfigRepairJobSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** Repo owner the config is repaired in. */
  owner: v.string(),
  /** Repo name the config is repaired in. */
  repo: v.string(),
  /** Branch the agent clones from and pushes the fix back onto. */
  branch: v.string(),
  status: envConfigRepairStatusSchema,
  /**
   * Post-repair validation outcome: true once the service re-validated the repo and
   * it satisfies the provider, false when it still doesn't, null until the run ends.
   */
  ok: v.nullable(v.boolean()),
  /** Residual validation issues from the post-repair re-validation. */
  issues: v.array(repoValidationIssueSchema),
  /** Live subtask counts from the repair agent's todo list; null until it reports. */
  subtasks: v.nullable(stepSubtasksSchema),
  /** Failure reason when `status` is `failed` (one-line; see `failure` for detail). */
  error: v.nullable(v.string()),
  /** Structured failure diagnostics when `status` is `failed`; null otherwise. */
  failure: v.nullable(agentFailureSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type EnvConfigRepairJob = v.InferOutput<typeof envConfigRepairJobSchema>
