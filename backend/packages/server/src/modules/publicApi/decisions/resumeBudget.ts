import { PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS } from '@cat-factory/contracts'
import type { ExecutionInstance } from '@cat-factory/contracts'

// The ceiling on `POST /api/v1/runs/:runId/decisions/pr-review/resume`, kept out of the route so
// the rule is unit-testable: the state it reasons about (several resumed reviews across a run's
// steps) is not reachable through the wire, since a resume needs a reviewer wedged mid-review.
//
// WHY THE PUBLIC SURFACE BOUNDS A LOOP THE APP DOES NOT. A resume STOPS the running reviewer and
// dispatches a fresh container, so an uncapped one is unbounded spend on a run nobody is watching:
// a poller resuming every ten minutes on a review that legitimately takes twenty kills it, over
// and over, each time it is about to finish. A person clicking Resume in the review window is
// looking at what they nudged, which is the judgement a headless caller cannot supply, so the
// ceiling belongs to the surface without the eyes rather than to the engine.

/**
 * How many resumes this run's review has already spent.
 *
 * Read off the RUN rather than tracked per caller, so the budget belongs to the review: a caller
 * that alternates keys, retries from a second process, or resumes after the app already did gets
 * the same answer. Taken as the maximum across the steps because a chain can carry more than one
 * `pr-reviewer` step and the count lives on each step's own review state.
 */
export function prReviewResumesSpent(execution: Pick<ExecutionInstance, 'steps'>): number {
  return execution.steps.reduce(
    (most, step) => Math.max(most, step.prReview?.resumeAttempts ?? 0),
    0,
  )
}

/**
 * The refusal when a run's review has spent its public resume budget, or `null` while it has some
 * left.
 *
 * The message names the evidence a caller should read INSTEAD of resuming again (`slices` against
 * `reportedSlices` says whether every slice is in, `lastActivityAt` whether anything is still
 * moving) plus the two exits. It carries no `details.reason`, like the wrong-status refusal beside
 * it: what a caller branches on is `resumeAttempts` against `maxResumeAttempts` on the decision
 * itself, which it can read BEFORE spending a call rather than after being refused one.
 */
export function prReviewResumeRefusal(execution: Pick<ExecutionInstance, 'steps'>): string | null {
  const spent = prReviewResumesSpent(execution)
  if (spent < PUBLIC_PR_REVIEW_MAX_RESUME_ATTEMPTS) return null
  return (
    `This review has already been resumed ${spent} times, which is all this API will spend on ` +
    'one review. Read `slices`, `reportedSlices` and `lastActivityAt` to see whether it is still ' +
    'working; resume it again from the app, or end the run with POST /api/v1/tasks/:taskId/stop.'
  )
}
