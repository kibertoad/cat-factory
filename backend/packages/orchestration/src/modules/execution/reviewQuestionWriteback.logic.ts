import { isHeadlessIntake, reviewAwaitsHuman } from '@cat-factory/contracts'
import { REVIEW_QUESTION_POLICIES } from '@cat-factory/kernel'
import type {
  ExecutionInstance,
  ReviewQuestionPost,
  ReviewQuestionSubject,
} from '@cat-factory/kernel'
import type { ReviewCommon } from '../review/IterativeReviewService.js'

// Pure decision + payload assembly for the headless clarification loop's question writeback
// (slice 2a of `docs/initiatives/headless-clarification-loop.md`). The side-effecting half —
// the workspace setting, the linked-issue lookup, the idempotency marker and the actual
// comment — lives in the `IssueWritebackProvider`; what belongs HERE is the engine's own
// half of the gate: whether this park is one a headless caller can only learn about through
// the ticket.

/**
 * Whether a parked review's open findings should be echoed onto the block's linked tracker
 * issue(s).
 *
 * Three conditions, all necessary:
 *
 * - **The run's intake matches the SUBJECT's audience** (`REVIEW_QUESTION_POLICIES`). For
 *   `requirements` that is `isHeadlessIntake`, the scope boundary the whole initiative is built
 *   on: a task started in the SPA has a human overseer in the app, and its clarification surface
 *   must not change. `intakeOrigin` is absent on every legacy run and degrades to `ui`, so the
 *   default is "post nothing". It is deliberately the CLASSIFICATION and not `=== 'public-api'`:
 *   a ticket pushed in by a per-ticket intake schedule is every bit as headless as an `/api/v1`
 *   start, and asking against the origin that shipped first is how the second one silently never
 *   reached the requester's ticket. For `clarity` the audience is every run, because asking a
 *   bug's REPORTER what they left out is intake semantics rather than a headless fallback.
 * - **The review is actually parked on findings** (`reviewAwaitsHuman`). `incorporated` has
 *   settled (the run advances) and the transient `incorporating` / `reviewing` / `merged` states
 *   are the driver's own work, not a wait on a human. Only `ready` and `exceeded` park, and that
 *   rule is stated once in contracts because the tracker-reply path has to agree with it: the
 *   review this echo asks about is the same one a reply comes back to.
 * - **There is something to ask.** A park with every finding answered or dismissed is waiting
 *   on the human to incorporate, not on an answer, so a comment would be noise.
 *
 * Note it does NOT consult the workspace's `writebackQuestionsOnPark` setting: that (with its
 * per-task override, and the subject's own `optIn`) is resolved by the provider alongside the
 * linked-issue lookup, so both halves of "should this issue get a comment" stay in one place.
 */
export function shouldPostReviewQuestions(
  instance: Pick<ExecutionInstance, 'intakeOrigin'>,
  review: Pick<ReviewCommon, 'status' | 'items'>,
  subject: ReviewQuestionSubject,
): boolean {
  if (
    REVIEW_QUESTION_POLICIES[subject].audience === 'headless' &&
    !isHeadlessIntake(instance.intakeOrigin)
  ) {
    return false
  }
  if (!reviewAwaitsHuman(review.status)) return false
  return review.items.some((item) => item.status === 'open')
}

/**
 * Assemble the provider payload for a parked review. Only OPEN findings are carried: an
 * answered or dismissed one is already settled, and re-posting it would read as a question
 * whose answer was ignored.
 */
export function buildReviewQuestionPost(
  instance: Pick<ExecutionInstance, 'id'>,
  review: Pick<ReviewCommon, 'id' | 'iteration' | 'maxIterations' | 'items'>,
  subject: ReviewQuestionSubject,
): ReviewQuestionPost {
  return {
    subject,
    reviewId: review.id,
    iteration: review.iteration,
    maxIterations: review.maxIterations,
    runId: instance.id,
    findings: review.items
      .filter((item) => item.status === 'open')
      .map((item) => ({ id: item.id, title: item.title, detail: item.detail })),
  }
}
