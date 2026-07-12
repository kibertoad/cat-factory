import * as v from 'valibot'

// ---------------------------------------------------------------------------
// Ephemeral-environment self-test run.
//
// A developer-triggered DIAGNOSTIC that exercises a service's configured
// ephemeral-environment provisioning end to end against a THROWAWAY branch:
//   1. create a temporary git branch off the service repo's default head,
//   2. provision an ephemeral environment for that branch,
//   3. tear the environment down,
//   4. delete the temporary branch,
//   5. report success — or the verbatim error and the stage it failed at.
//
// Unlike a `deployer` pipeline step it touches NO board block, leaves NO
// service frame, and always cleans up (even on failure), so it never leaves an
// orphaned branch or environment behind. It is a durable, asynchronous,
// observable run (its own `environment_test_runs` row), driven like a bootstrap
// run, so it never blocks the triggering request. The SPA shows the live stage
// as it advances.
// ---------------------------------------------------------------------------

/** The ordered lifecycle stages of an environment-test run. */
export const environmentTestStageSchema = v.picklist([
  'creating_branch',
  'provisioning',
  'tearing_down',
  'deleting_branch',
  'done',
])
export type EnvironmentTestStage = v.InferOutput<typeof environmentTestStageSchema>

/** Terminal-ness of an environment-test run. */
export const environmentTestStatusSchema = v.picklist(['running', 'succeeded', 'failed'])
export type EnvironmentTestStatus = v.InferOutput<typeof environmentTestStatusSchema>

/** One ephemeral-environment self-test run, with its live stage + final outcome. */
export const environmentTestRunSchema = v.object({
  id: v.string(),
  workspaceId: v.string(),
  /** The service frame (board block) whose provisioning config is being tested. */
  blockId: v.string(),
  status: environmentTestStatusSchema,
  /** The stage currently in flight (or `done` when finished successfully). */
  stage: environmentTestStageSchema,
  /** The temporary branch the run created; null until it is created. */
  branch: v.nullable(v.string()),
  /** The provisioned environment's URL, when the provider exposed one. */
  envUrl: v.nullable(v.string()),
  /** One-line failure reason when `status` is `failed`; null otherwise. */
  error: v.nullable(v.string()),
  /** The stage the run was at when it failed; null unless `status` is `failed`. */
  failedStage: v.nullable(environmentTestStageSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type EnvironmentTestRun = v.InferOutput<typeof environmentTestRunSchema>
