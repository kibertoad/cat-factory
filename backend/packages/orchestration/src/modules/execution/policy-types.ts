import type {
  ClassRulesByRole,
  MergeClassRules,
  RequirementConcernLevel,
  StepGating,
  WorkspaceRole,
} from '@cat-factory/kernel'

/**
 * The effective risk/merge policy for one run, as {@link RunMergePolicy.resolve} resolves it
 * (the block's selected preset, else the workspace default, else the built-in
 * `DEFAULT_RISK_POLICY`). Every gate window receives that resolver as a bound call-back and
 * reads only the subset it gates on.
 *
 * It lives in its own module — rather than beside the engine — so `RunMergePolicy` and the gate
 * windows can both name it without importing `ExecutionService` (which imports them).
 */
export interface ResolvedRunRiskPolicy {
  /**
   * The resolved preset's id, absent when the built-in `DEFAULT_RISK_POLICY` fallback was used
   * (no repository / no default seeded yet) — that fallback is a constant, not a row. Recorded
   * on the merge track record so a decision can be read back in its policy context.
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
  releaseWatchWindowMinutes: number
  releaseMaxAttempts: number
  humanReviewGraceMinutes: number
  /** Judge steps: the minimum verdict score to advance, and the rework bounce budget. */
  judgeMinScore: number
  judgeMaxBounces: number
  autoMergeEnabled: boolean
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
}
