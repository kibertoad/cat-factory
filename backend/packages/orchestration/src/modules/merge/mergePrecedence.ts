import type { MergeAssessment, MergeAxis, MergeClassRule, MergeDecision } from '@cat-factory/kernel'

// The auto-merge precedence ladder as a pure function, shared by the merger step's resolver and
// the public PR assessment, so a verdict given without a run is the one a run would have reached.

/** The three score ceilings a policy compares an assessment against. */
export interface MergeCeilings {
  maxComplexity: number
  maxRisk: number
  maxImpact: number
}

/**
 * The merge-decision reasons a review card can carry: every reason except the two that MERGED
 * (which raise no card) and `merge_partial` (which `finalizeMerge` has already reported with its
 * own enumerated card). Stated by EXCLUSION rather than as a list, so a reason added to the
 * contract arrives in `MergeResolver`'s `REVIEW_CARD_LEAD` as a missing key and fails the build until
 * somebody words it, instead of silently inheriting whichever arm happened to be last.
 */
export type ReviewCardReason = Exclude<
  MergeDecision['reason'],
  'within_thresholds' | 'class_auto_merge' | 'merge_partial'
>

/**
 * Everything the auto-merge precedence ladder decides on, gathered so the ladder itself can be one
 * pure function rather than a pair of nested ternaries inside the resolver.
 */
export interface MergePrecedenceInput {
  /** The run was SANDBOXED: it may land nothing, whatever the policy says. */
  dryRun: boolean
  /** The initiator's role may land this change class (true when nothing scopes them). */
  submissionAllowed: boolean
  /** The preset's master switch. */
  autoMergeEnabled: boolean
  /**
   * A real preset resolved (block pin or workspace default). False means the run fell back to the
   * built-in `FALLBACK_RISK_POLICY`, the ONLY policy with no id, which is why the id's absence is
   * the signal rather than a guess. It never changes WHAT the ladder decides, only what the
   * refusal is called: the fallback already carries `autoMergeEnabled: false`.
   */
  policyConfigured: boolean
  /** The class rule as narrowed by the initiator's role. */
  effectiveRule: MergeClassRule
  /** The role's entry is what produced `effectiveRule` (it is stricter than the base rule). */
  narrowedByRole: boolean
  /** The merger produced a parseable assessment at all. */
  hasAssessment: boolean
  /** ...and explained it, which is the backstop against a bogus 0/0/0 auto-merging. */
  credible: boolean
  /** Every axis is at or below its ceiling. */
  withinThresholds: boolean
}

/** What the ladder decides: merge, or leave it for a human and say precisely why. */
export interface MergePrecedenceVerdict {
  merge: boolean
  /** The reason to record when the merge lands (unused when `merge` is false). */
  mergeReason: MergeDecision['reason']
  /** The reason to record when it does not (unused when `merge` is true). */
  reviewReason: ReviewCardReason
}

/**
 * The auto-merge precedence ladder, most-significant first:
 *
 *   1. A DRY RUN merges nothing, whatever else says. It outranks even `autoMergeEnabled` because
 *      it is a property of the RUN rather than of the policy: the person who started it was never
 *      authorised to land this work, so no preset can consent on their behalf.
 *   2. The initiator's SUBMISSION ALLOWLIST, when their role carries one and this run's class is
 *      outside it. Beside `dry_run` and above the master switch for the same reason: it is about
 *      WHO started the run. What separates it from a `never` class rule is that it also refuses
 *      the MANUAL merge, so it is a bar on landing rather than a demand for review.
 *   3. `autoMergeEnabled: false`, the master switch. "Manual review only" stays manual and a
 *      class rule can NEVER override it. The unconfigured fallback refuses on this same rung, and
 *      is reported as `no_policy_configured` rather than borrowing the preset's name.
 *   4. The class rule AS NARROWED BY THE INITIATOR'S ROLE: `always` merges regardless of the
 *      scores, and regardless of the rationale backstop, because an explicit operator policy
 *      keyed on a DETERMINISTIC backend classification outranks the agent's self-report; `never`
 *      always routes to a human. A role entry can only push this arm toward `never`.
 *   5. The credibility + threshold comparison.
 *
 * The review reason is derived HERE, in the same order and from the same inputs, because the two
 * used to be written twice and the pair has to agree: a decision that declines to merge on one
 * rung and blames another sends the reader to edit a setting that had no part in the outcome.
 * Every rung is kept apart from its neighbours because each needs a DIFFERENT fix. `dry_run` is
 * fixed by re-running live, `submission_not_allowed` by a teammate on a permitted tier or a wider
 * allowlist, `role_requires_review` by any reviewer, `class_requires_review` by editing the class
 * rule, and `no_rationale` (scores but no explanation) is not `no_assessment` (no scores at all).
 */
export function resolveMergePrecedence(input: MergePrecedenceInput): MergePrecedenceVerdict {
  const { effectiveRule } = input
  const merge =
    !input.dryRun &&
    input.submissionAllowed &&
    input.autoMergeEnabled &&
    (effectiveRule === 'always' ||
      (effectiveRule !== 'never' && input.credible && input.withinThresholds))
  return {
    merge,
    mergeReason: effectiveRule === 'always' ? 'class_auto_merge' : 'within_thresholds',
    reviewReason: reviewReasonFor(input),
  }
}

/** Why review is needed, in the same order {@link resolveMergePrecedence} applies. */
function reviewReasonFor(input: MergePrecedenceInput): ReviewCardReason {
  if (input.dryRun) return 'dry_run'
  if (!input.submissionAllowed) return 'submission_not_allowed'
  // Same rung, two names. A deployment that stated no merge policy and a preset that states
  // "always ask a human" both refuse here, and sending the first reader to edit a preset they do
  // not have is the misattribution this whole ladder exists to avoid.
  if (!input.autoMergeEnabled) {
    return input.policyConfigured ? 'auto_merge_disabled' : 'no_policy_configured'
  }
  if (input.effectiveRule === 'never') {
    return input.narrowedByRole ? 'role_requires_review' : 'class_requires_review'
  }
  if (!input.hasAssessment) return 'no_assessment'
  return input.credible ? 'exceeded_thresholds' : 'no_rationale'
}

/** The assessment axes that exceed their preset ceiling (empty when all are within). */
export function exceededAxesOf(assessment: MergeAssessment, preset: MergeCeilings): MergeAxis[] {
  const axes: MergeAxis[] = []
  if (assessment.complexity > preset.maxComplexity) axes.push('complexity')
  if (assessment.risk > preset.maxRisk) axes.push('risk')
  if (assessment.impact > preset.maxImpact) axes.push('impact')
  return axes
}

/**
 * A credible assessment explains itself: a merger that examined the diff returns a rationale, while
 * one that failed to inspect the change returns bare scores (the bug that auto-merged a bogus
 * 0/0/0). The non-empty rationale is the backstop that keeps those from merging silently.
 */
export function isCredibleAssessment(assessment: MergeAssessment | null): boolean {
  return assessment !== null && assessment.rationale.trim() !== ''
}
