import * as v from 'valibot'

// ---------------------------------------------------------------------------
// DEPLOY-REMEDIATION step state: the live loop state a `deployer` step carries while its
// `deploy-fixer` helper repairs a failed provision.
//
// Split out of `execution.ts` along the seam the other per-step-kind state clusters already sit
// behind (`gate.ts`, `judge.ts`, `forkDecision.ts`); `execution.ts` composes it back onto
// `PipelineStep` as the `deployFix` field.
//
// The loop is owned by the DEPLOYER rather than by a gate after it, because the deployer already
// owns provisioning through to a terminal verdict: a gate probing the environment status would
// re-read what the deployer just wrote. The full reasoning, and the classification precondition
// that decides whether the loop may run at all, live in
// `docs/initiatives/deployment-failure-remediation.md`.
// ---------------------------------------------------------------------------

/**
 * How many times the `deploy-fixer` may repair-and-retry before the failure becomes terminal.
 * Two, because the value is concentrated in the first pass (the provider's error names the field
 * at fault and the manifests are in the checkout it already has); a second covers a first fix that
 * was right about the cause and wrong about the remedy. Past that, a loop that has twice failed to
 * stand the environment up is not converging.
 */
export const DEFAULT_DEPLOY_FIX_MAX_ATTEMPTS = 2

/** Bounds on the per-step budget: `0` disables the loop, 5 is the ceiling. */
export const deployFixAttemptsSchema = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5))

/**
 * A `deployer` step's remediation configuration (`stepOptions.deployFix`), the deployer-only
 * per-step knob beside `retainEnvironment`.
 *
 * On the STEP rather than on the risk policy, where the CI fixer's budget lives, because the two
 * answer different questions. `ciMaxAttempts` states how much automatic rework this WORK is worth
 * before a human looks, which is a risk-appetite judgement about the change. Whether a failed
 * provision is worth an automatic repair is a fact about the ENVIRONMENT: a throwaway preview
 * stack wants the automation and a deployer pointed at shared infrastructure may want a person on
 * every failure, and the task's risk appetite says nothing about which of those this step is.
 */
export const deployFixConfigSchema = v.object({
  /**
   * Whether a repo-fixable provisioning failure escalates to the `deploy-fixer`. Absent ⇒
   * enabled. `false` restores the prior behaviour exactly: the failure is terminal and surfaced
   * for a human retry.
   */
  enabled: v.optional(v.boolean()),
  /** Attempt budget; absent ⇒ {@link DEFAULT_DEPLOY_FIX_MAX_ATTEMPTS}. */
  maxAttempts: v.optional(deployFixAttemptsSchema),
})
export type DeployFixConfig = v.InferOutput<typeof deployFixConfigSchema>

/**
 * One `deploy-fixer` round, recorded when its job settles so the run detail can show what each
 * attempt was asked to fix and how it ended. The deploy analogue of `gateAttemptSchema`.
 *
 * There is deliberately no "did it work" field here. Whether the repair worked is established by
 * the RE-PROVISION that follows, never by the agent's own account of itself: the same rule the
 * teardown probe and the bugfix reproduction proof are built on.
 */
export const deployFixAttemptSchema = v.object({
  /**
   * 1-based ordinal in this log. It matches `attempts` on a run that never loops back to the
   * deployer, and diverges from it after one: the counter is re-armed for each provisioning cycle
   * (`restartDeployFixState`) while these rows survive the whole run, being what the verification
   * report reduces.
   */
  attempt: v.number(),
  /**
   * The 0-based provisioning CYCLE this round was dispatched in. A loop-back to the deployer
   * re-arms the budget and opens a new cycle (`restartDeployFixState`) while these rows
   * survive the whole run, so the marker is what tells a reader which rounds were counted
   * against the LIVE budget and how many cycles the log spans. Absent on a row written before
   * the field existed, which reads as cycle 0, the only cycle such a run had reached.
   */
  cycle: v.optional(v.nullable(v.number())),
  /** Epoch ms when the fixer job settled. */
  at: v.number(),
  /** Whether the fixer's own job completed or died without finishing. */
  outcome: v.picklist(['completed', 'failed']),
  /** The classified cause this round was dispatched against. */
  reason: v.string(),
  /** The provisioning error this round was handed. */
  error: v.string(),
  /** The fixer's account of what it changed, or the job error when it failed. */
  summary: v.optional(v.nullable(v.string())),
})
export type DeployFixAttempt = v.InferOutput<typeof deployFixAttemptSchema>

/**
 * The live remediation state on a `deployer` step.
 *
 * `phase: 'fixing'` is the DISCRIMINATOR the poll path reads. A deployer step's in-flight job is
 * normally a container-backed DEPLOY polled through the provisioning service; while this phase is
 * set it is an AGENT job polled through the executor instead. Both ride `step.jobId`, so without
 * the phase the poll router hands the fixer's job to the deploy poller, which never dispatched it
 * and cannot find it.
 *
 * Absent on a deployer that never failed, so a successful deploy persists exactly the shape it did
 * before this existed.
 */
export const deployFixStateSchema = v.object({
  phase: v.picklist(['fixing', 'retrying']),
  /** Fixer rounds dispatched so far. */
  attempts: v.number(),
  /** The budget resolved at the FIRST escalation, frozen so a mid-run pipeline edit can't move it. */
  maxAttempts: v.number(),
  /** The service frame whose provision is being remediated. */
  frameId: v.string(),
  /** The classified cause ({@link EnvironmentFailureReason}) that admitted this loop. */
  reason: v.string(),
  /** The provisioning error the in-flight round was handed. */
  lastError: v.string(),
  /**
   * The 0-based provisioning cycle now running, bumped by `restartDeployFixState`. It is
   * what {@link deployFixAttemptSchema}'s own `cycle` is stamped from, and what scopes a read of
   * the run-long log back to the rounds the live budget was spent on.
   */
  cycle: v.optional(v.nullable(v.number())),
  /**
   * Per-round history, newest last, CAPPED at {@link MAX_DEPLOY_FIX_ATTEMPT_LOG}. The log
   * survives the whole run (the verification report reduces it) while the state rides the run's
   * `detail` JSON, which is re-serialized on every step write, so an uncapped log would grow
   * with every loop-back for the rest of the run. See {@link droppedAttempts}.
   */
  attemptLog: v.optional(v.nullable(v.array(deployFixAttemptSchema))),
  /**
   * How many of the oldest rounds the {@link attemptLog} cap has dropped. Recorded rather than
   * silently truncated: the report counts finished and died rounds off the surviving rows, so a
   * dropped one would otherwise turn into a round that reads as never having run.
   */
  droppedAttempts: v.optional(v.nullable(v.number())),
})
export type DeployFixState = v.InferOutput<typeof deployFixStateSchema>

/**
 * How many `deploy-fixer` rounds the run-long {@link deployFixStateSchema.entries.attemptLog}
 * keeps. Four times the per-cycle ceiling of 5, so only a run that looped its deployer back
 * several times over reaches it, and what it then drops is the oldest cycle rather than the one
 * a reader is looking at.
 */
export const MAX_DEPLOY_FIX_ATTEMPT_LOG = 20
