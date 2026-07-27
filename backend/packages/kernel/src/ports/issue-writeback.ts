import type { Block, PullRequestRef } from '../domain/types.js'

/** One open finding of a parked review, as rendered onto a tracker issue. */
export interface ReviewQuestionFinding {
  /** The review item's stable id — rendered verbatim so an answer can name it. */
  id: string
  /** Short headline of the concern. */
  title: string
  /** The full question / gap, in plain prose. */
  detail: string
}

/**
 * A parked review's open findings, ready to be posted onto the block's linked tracker
 * issue(s). Built by the engine (which owns the run's intake origin and the review) and
 * handed to the provider, which resolves the workspace's writeback settings, the linked
 * issues, and the per-issue idempotency marker.
 */
export interface ReviewQuestionPost {
  /** The parked review's id — half of the idempotency key. */
  reviewId: string
  /** The review's iteration number — the other half, so each pass posts exactly once. */
  iteration: number
  /** The review's iteration cap, rendered so a reader knows how many passes remain. */
  maxIterations: number
  /** The open findings. Never empty (the engine skips the call when there are none). */
  findings: ReviewQuestionFinding[]
  /** The run whose park these findings belong to — named so an answer can address it. */
  runId: string
}

/** What a {@link IssueWritebackProvider.postReviewQuestions} call actually did. */
export interface ReviewQuestionPostOutcome {
  /** Linked issues this iteration's comment was posted onto just now. */
  posted: number
  /** Linked issues that already carried this iteration's comment (a driver replay). */
  skipped: number
  /** Linked issues whose post failed — the park is still discoverable in-app. */
  failed: number
}

// Issue-tracker writeback port. As a task's PR progresses, the execution engine
// asks this provider to write back to the task's linked tracker issue(s): post a
// comment when the PR opens, and comment + close the issue as resolved when the PR
// merges. The concrete provider resolves the workspace's writeback settings (with
// the per-task override on the block), finds the linked issues via the task
// projection, and dispatches per source (GitHub Issues / Jira).
//
// Every method is best-effort: the engine calls them fire-and-forget so a tracker
// outage never fails a run. A provider that finds writeback disabled (workspace
// off and no task override) or no linked issues simply does nothing.

export interface IssueWritebackProvider {
  /** A task's implementation PR just opened — comment on its linked tracker issue(s). */
  onPullRequestOpened(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /** A task's PR merged — comment + close its linked tracker issue(s) as resolved. */
  onPullRequestMerged(workspaceId: string, block: Block, pr: PullRequestRef): Promise<void>
  /**
   * The recurring `bug-intake` step just picked the block's linked issue up —
   * post a "taken by cat-factory" comment (with the run/board link when given)
   * and mark the issue in-progress: the vendor's in-progress workflow transition
   * (Jira in-progress status category / Linear `started` state), or for GitHub —
   * which has no native status — apply `inProgressLabel` (default `in-progress`),
   * creating the label if absent. Unlike the PR hooks this is NOT gated on the
   * workspace writeback settings: the pickup mark is intake semantics (the whole
   * point is claiming the issue where it was filed), not an optional courtesy.
   */
  onIssuePickedUp(
    workspaceId: string,
    blockId: string,
    info: { runUrl?: string; inProgressLabel?: string },
  ): Promise<void>
  /**
   * The bug-triage clarification gate (`clarity-review`) parked for a human because the
   * investigator flagged the report as unclear — echo the open questions as a comment on
   * the block's linked tracker issue(s) so the reporter sees the ask where they filed the
   * bug. This is an ECHO only: answers still arrive in-app (the clarity window); there is
   * no tracker-side reply polling. Best-effort like the other hooks (a tracker outage never
   * fails the run) and, like {@link onIssuePickedUp}, NOT gated on the workspace writeback
   * settings — asking the reporter for the detail needed to fix their bug is intake
   * semantics, not an optional courtesy. A no-op when the block has no linked issue.
   */
  postQuestions(workspaceId: string, blockId: string, questions: string[]): Promise<void>
  /**
   * A HEADLESS run's requirements review parked with open findings — post them, each with
   * its stable finding id, onto the block's linked tracker issue(s) so the loop is
   * answerable from where the work was requested.
   *
   * Unlike {@link postQuestions} (the bug-triage echo, which is intake semantics and always
   * fires) this IS gated on the workspace's `writebackQuestionsOnPark` setting with the
   * per-task `Block.trackerQuestionsOnPark` override, because the requirements loop has a
   * perfectly good in-app surface for every UI-started task and this is the opt-in headless
   * alternative. The engine has already established that the run is headless and the review
   * has open findings; the provider owns the settings, the linked-issue lookup, and the
   * per-`(review, iteration, issue)` idempotency marker that keeps a durable-driver replay
   * from double-posting.
   *
   * Best-effort per issue like every other hook, but NOT silent: the returned outcome
   * reports what was posted, skipped as already-posted, and failed, so the caller can log a
   * tracker outage rather than leaving it invisible.
   */
  postReviewQuestions(
    workspaceId: string,
    block: Block,
    post: ReviewQuestionPost,
  ): Promise<ReviewQuestionPostOutcome>
}
