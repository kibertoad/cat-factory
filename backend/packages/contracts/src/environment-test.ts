import * as v from 'valibot'
import { environmentProbeReportSchema } from './environment-probe.js'
import { stepSubtasksSchema } from './execution.js'

// ---------------------------------------------------------------------------
// Ephemeral-environment self-test run.
//
// A developer-triggered DIAGNOSTIC that exercises a service's configured
// ephemeral-environment provisioning end to end against a THROWAWAY branch:
//   1. create a temporary git branch off the service repo's default head,
//   2. provision an ephemeral environment for that branch,
//   3. in `agent-probe` mode, hand that environment to an agent and have it try to
//      OPERATE the service, reporting what it attempted and what it could not work out,
//   4. tear the environment down,
//   5. delete the temporary branch,
//   6. report success, or the verbatim error and the stage it failed at.
//
// Unlike a `deployer` pipeline step it touches NO board block, leaves NO
// service frame, and always cleans up (even on failure), so it never leaves an
// orphaned branch or environment behind. It is a durable, asynchronous,
// observable run (its own `environment_test_runs` row), driven like a bootstrap
// run, so it never blocks the triggering request. The SPA shows the live stage
// as it advances.
// ---------------------------------------------------------------------------

/**
 * What a run EXERCISES. Both modes share the whole lifecycle, the cleanup contract and the run
 * store; the agent mode adds one stage in the middle.
 *
 *  - `provision`: the provisioning config alone. Does the environment stand up and come down?
 *  - `agent-probe`: that, plus the question after it. Handed this environment, its credentials
 *    and the repository, can an AGENT work out how to operate the service? See
 *    `environment-probe.ts` for what it reports.
 */
export const environmentTestModeSchema = v.picklist(['provision', 'agent-probe'])
export type EnvironmentTestMode = v.InferOutput<typeof environmentTestModeSchema>

/**
 * The ordered lifecycle stages of an environment-test run.
 *
 * `probing` is reached only in `agent-probe` mode, between a `ready` environment and its
 * teardown. Every mode still passes through `tearing_down` and `deleting_branch`, because the
 * always-cleans-up contract is the whole reason a developer is willing to press either button.
 */
export const environmentTestStageSchema = v.picklist([
  'creating_branch',
  'provisioning',
  'probing',
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
  mode: environmentTestModeSchema,
  /**
   * Terminal-ness of the LIFECYCLE, never the finding.
   *
   * `succeeded` means the run did everything it set out to do and left nothing behind, including
   * an agent dry run whose verdict is `inoperable`, which is a completed diagnostic reporting bad
   * news. Folding the verdict in here would make the one interesting outcome indistinguishable
   * from a broken diagnostic, and would leave a real teardown failure with nothing to say. What
   * the agent FOUND is {@link environmentTestRunSchema.entries.probe}'s `verdict`.
   */
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
  /**
   * What the dry-run agent reported, once the `probing` stage settled. Null in `provision` mode,
   * and in `agent-probe` mode until the probe returns, including on a run that FAILED before or
   * during the probe, where the run's `error` says why there is no report. The two absences are
   * told apart by `mode` and `failedStage`, never by this field alone.
   */
  probe: v.nullable(environmentProbeReportSchema),
  /**
   * The dry-run agent's live todo counts while the `probing` stage is in flight, lifted from the
   * container's own progress exactly as a pipeline step's are.
   *
   * Carried on the run rather than left in the container because `probing` is the LONGEST stage
   * this flow has (a model reading a repository and driving a service, minutes of it) and every
   * other stage moves the SPA within seconds. With nothing written, no `envTestChanged` event
   * fires for the whole probe and the card sits frozen on "probing with an agent", which reads
   * exactly like a wedged run. Null in `provision` mode, before the prober reports any progress,
   * and once the report has landed.
   */
  probeProgress: v.nullable(stepSubtasksSchema),
  createdAt: v.number(),
  updatedAt: v.number(),
})
export type EnvironmentTestRun = v.InferOutput<typeof environmentTestRunSchema>
