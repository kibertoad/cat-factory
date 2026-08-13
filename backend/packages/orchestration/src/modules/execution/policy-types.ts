import type {
  ExecutionInstance,
  ClassRulesByRole,
  MergeClassRules,
  RequirementConcernLevel,
  RunAutonomy,
  StepGating,
  SubmissionClassesByRole,
  WorkspaceRole,
} from '@cat-factory/kernel'

/**
 * What policy resolution needs to know about the RUN, as opposed to the task: which of the
 * workspace's two defaults applies when the task pinned no policy of its own.
 *
 * A structural `Pick` rather than the whole instance, so a caller holding only the run's
 * provenance can satisfy it, and so a call site that has not threaded the run through fails to
 * compile naming the one field that matters. It lives here, beside the resolved policy, for the
 * reason the resolved policy does: every gate window has to name it and none of them may import
 * the engine.
 */
export type RunPolicyScope = Pick<ExecutionInstance, 'intakeOrigin'>

/**
 * The effective risk/merge policy for one run, as {@link RunMergePolicy.resolve} resolves it
 * (the block's selected preset, else the workspace default, else the built-in
 * `FALLBACK_RISK_POLICY`). Every gate window receives that resolver as a bound call-back and
 * reads only the subset it gates on.
 *
 * It lives in its own module — rather than beside the engine — so `RunMergePolicy` and the gate
 * windows can both name it without importing `ExecutionService` (which imports them).
 */
export interface ResolvedRunRiskPolicy {
  /**
   * The resolved preset's id, absent when the built-in `FALLBACK_RISK_POLICY` was used (no
   * repository wired): that fallback is a constant, not a row, and it is the one policy that
   * auto-merges nothing. Recorded on the merge track record so a decision can be
   * read back in its policy context.
   */
  id?: string
  name: string
  maxComplexity: number
  maxRisk: number
  maxImpact: number
  ciMaxAttempts: number
  maxRequirementIterations: number
  maxRequirementConcernAllowed: RequirementConcernLevel
  maxTesterQualityIterations: number
  /**
   * How many automatic REWORK rounds a companion may drive before it parks for a person. Read
   * ONCE per companion step, on its first grading (`CompanionController.applyAssessment`), which is
   * why a human-granted extra round survives: the grant raises the step's own budget afterwards.
   */
  companionMaxReworks: number
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  /** Judge steps: the minimum verdict score to advance, and the rework bounce budget. */
  judgeMinScore: number
  judgeMaxBounces: number
  autoMergeEnabled: boolean
  /**
   * Whether this run answers the parks its own AUTOMATIC loops raise when they give up (a
   * companion at its rework cap, an iterative review at its pass cap, untriaged Coder follow-ups),
   * or stops for a person. Never touches a gate a pipeline asked for.
   *
   * Optional here alone: the field is required on a stored policy, and a hand-built subset in a
   * test that gates on nothing else should not have to state a posture it never reads. Absent is
   * read as `attended` everywhere, which is the historical behaviour.
   */
  autonomy?: RunAutonomy
  forkDecision?: StepGating | null
  /**
   * Per-change-class auto-merge rules. Absent on the built-in fallback ⇒ every class uses the
   * score ceilings, which is the historical behaviour.
   */
  classRules?: MergeClassRules
  /**
   * Per-ROLE narrowing of {@link classRules}, applied against the role the run pinned at start
   * ({@link ExecutionInstance.initiatedByRole}). Narrow-only, so absent — on the built-in fallback
   * and on any preset authored before this existed — leaves every role on the base rules.
   */
  classRulesByRole?: ClassRulesByRole
  /**
   * The roles whose runs this preset forces into dry-run mode. Read at START (that is when a run's
   * mode is settled and pinned), never at merge time: a run that was admitted as live must not
   * become un-mergeable because the preset was edited while it worked, and a run admitted as a dry
   * run must stay sandboxed even if the role is un-listed mid-flight.
   */
  dryRunRoles?: readonly WorkspaceRole[]
  /**
   * Per-ROLE allowlist of the change classes this preset will land at all. Read at MERGE time
   * rather than at start (the opposite of `dryRunRoles` above), because the class is derived from
   * the pull request's changed files and does not exist until there is a pull request. That is
   * not a weaker guarantee, only a later one: opening the PR was never the harm, landing it is.
   */
  submissionClassesByRole?: SubmissionClassesByRole
}

/**
 * Whether this policy lets a run ANSWER the parks its own automatic loops raise, rather than
 * stopping for a person who may not be there.
 *
 * Stated once, and as `=== 'unattended'` rather than `!== 'attended'`, because the vocabulary is
 * closed and PERSISTED: a row written under a member later retired reads back as neither, and the
 * two spellings disagree about it in the one direction that matters. Not knowing what a policy
 * says is not a licence to proceed unattended, so an unrecognised value parks like every policy
 * did before this existed.
 */
export function resolvesOwnCaps(policy: Pick<ResolvedRunRiskPolicy, 'autonomy'>): boolean {
  return policy.autonomy === 'unattended'
}
