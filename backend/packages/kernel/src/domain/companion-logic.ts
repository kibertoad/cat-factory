import {
  hasBlockingReviewComments,
  hasReviewCommentsBeyondNits,
  type StepReviewComment,
} from '@cat-factory/contracts'

// ---------------------------------------------------------------------------
// The PURE half of the companion machine (the `judge-logic.ts` counterpart): given a parsed
// assessment, the step's threshold and its rework budget, decide what the engine does with the
// producer under review. No ports, no I/O — so the rule that a MUST-FIX finding holds the run is
// unit-testable without the engine, and reads in one place rather than as three branches spread
// down a controller.
//
// It lives beside the judge's because the two buckets answer the same question with different
// inputs, and the answers have to stay recognisably the same shape: both grade repeatedly on a
// budget, both may hand the result to a person, and only ONE of the ways they stop is the
// automation reporting that it gave up (see {@link CompanionParkReason}).
// ---------------------------------------------------------------------------

/**
 * WHY a companion stopped for a person, as a closed vocabulary rather than prose.
 *
 * The distinction is the whole safety property of the unattended posture (ADR 0053):
 *  - `budget_spent` — the rework rounds are exhausted and the rating never reached the bar. A
 *    person's answer here only confirms that the loop should stop trying, which is what makes it
 *    the one an unattended risk policy may answer on their behalf.
 *  - `blocking_findings` — the reviewer named at least one `blocker`: a point it says must be
 *    fixed before this work goes further. Accepting the work anyway is a JUDGEMENT that overrules
 *    a review, not a decision to stop retrying, so no policy takes it. An unattended run parks
 *    here exactly as an attended one does.
 *
 * A value rather than a matched note, for the reason the judge's is: display prose is one wording
 * change away from re-pointing the decision silently.
 */
export type CompanionParkReason = 'budget_spent' | 'blocking_findings'

/**
 * WHICH reason a companion parks for, given the findings its latest round raised.
 *
 * One function rather than a branch at each park site, because a second copy is how a loop that
 * ABANDONED its budget early comes to report the spent budget it merely resembles. Both places that
 * stop for a person read it: {@link disposeCompanionVerdict} when the rounds run out, and the
 * engine's unproductive-loop exit when it gives the rest of them up.
 *
 * It is total over the findings and answers with a reason ALWAYS, which is the other half of the
 * point: asking the disposition rule to re-decide with an emptied budget can answer `pass`, and a
 * caller that expected a park reason then reads "advance" as "hold".
 */
export function companionParkReasonFor(
  comments: readonly StepReviewComment[] | undefined,
): CompanionParkReason {
  return hasBlockingReviewComments(comments) ? 'blocking_findings' : 'budget_spent'
}

/** What {@link disposeCompanionVerdict} needs to decide. */
export interface CompanionDispositionInput {
  /** The overall quality score the companion returned, 0..1. */
  rating: number
  /** The bar it must reach, from the step's own configuration. */
  threshold: number
  /** The findings this round raised, severity-graded (see contracts' `stepReviewCommentSchema`). */
  comments: readonly StepReviewComment[] | undefined
  /** How many AUTOMATIC rework rounds this companion has already driven. */
  attempts: number
  /** The ceiling on those rounds, adopted from the run's risk policy. */
  maxAttempts: number
  /**
   * Whether a step this companion reviews actually precedes it. With none there is genuinely
   * nothing to grade, so the verdict cannot hold anything back and the run advances — a parameter
   * rather than an assumption, exactly as the judge's `hasBounceTarget` is.
   */
  hasProducer: boolean
}

/** The decision, plus the reason to record on the step when it stopped for a person. */
export interface CompanionDispositionResult {
  /** `pass` advances (or raises the step's own approval gate); `rework` re-runs the producer. */
  disposition: 'pass' | 'rework' | 'park'
  /** Set exactly when `disposition` is `park`; see {@link CompanionParkReason}. */
  parkReason?: CompanionParkReason
}

/**
 * Decide what to do with a companion's assessment.
 *
 *  - no producer to grade → `pass` (nothing was reviewed, so nothing can be held);
 *  - any `blocker` finding → `rework` while a round is left, else `park` (`blocking_findings`);
 *  - the FIRST batch raising anything the reviewer did not call a nit → `rework` while a round is
 *    left. That first batch is worth a round even from a producer that scored well, and it is the
 *    whole reason a threshold governs the SECOND pass onward. A policy buying no rounds has already
 *    answered that, so with no budget the rating decides alone. MINOR-ONLY is deliberately not
 *    enough (`hasReviewCommentsBeyondNits`): the reviewer is told a `minor` is "a nit, polish or
 *    suggestion, never worth holding anything for" (agents' `REVIEW_FINDINGS_LAYOUT`), so a rule
 *    that spent a producer re-run plus a re-grading call on one would make that instruction false,
 *    and the grade would then decide nothing a reviewer could predict;
 *  - at or above the threshold → `pass`;
 *  - below it → `rework` while a round is left, else `park` (`budget_spent`).
 *
 * The float comparison is `>=` on purpose: a threshold of `0.8` must be met exactly by a rating of
 * `0.8`, which is the number an operator typed into the step.
 */
export function disposeCompanionVerdict(
  input: CompanionDispositionInput,
): CompanionDispositionResult {
  const { rating, threshold, comments, attempts, maxAttempts, hasProducer } = input
  if (!hasProducer) return { disposition: 'pass' }
  const hasBudget = attempts < maxAttempts
  // Checked before the rating, and NOT gated on there being budget left: a blocker is the one
  // outcome a spent budget must not convert into a pass. Where an exhausted quality loop can
  // honestly say "this is as good as it got", an open must-fix says the opposite.
  if (hasBlockingReviewComments(comments)) {
    return hasBudget
      ? { disposition: 'rework' }
      : { disposition: 'park', parkReason: companionParkReasonFor(comments) }
  }
  if (attempts === 0 && hasBudget && hasReviewCommentsBeyondNits(comments)) {
    return { disposition: 'rework' }
  }
  if (rating >= threshold) return { disposition: 'pass' }
  return hasBudget
    ? { disposition: 'rework' }
    : { disposition: 'park', parkReason: companionParkReasonFor(comments) }
}
