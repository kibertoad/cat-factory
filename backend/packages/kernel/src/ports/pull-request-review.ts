// Port for reading a block's GitHub PR review state — the human code review on the pull
// request an implementation step opened. The execution engine's `human-review` gate polls
// this between durable sleeps to decide whether the PR is approved (advance), still awaiting
// review (keep waiting) or has unresolved review threads (dispatch the `fixer` to address
// them). Modelled as a port so core stays free of GitHub specifics; the facade resolves the
// block's repo target + PR number and reads reviews / review threads / required approvals.

/** One unresolved review thread on the PR (a GitHub review-comment conversation). */
export interface ReviewThread {
  /** GraphQL node id of the thread — used to reply to and resolve it. */
  threadId: string
  /** Login of the thread's first comment author, or '' when unknown. */
  author: string
  /** A short excerpt of the thread's latest comment, for the fixer prompt + UI. */
  bodyExcerpt: string
  /** Repo-relative file path the thread is anchored to, or null for a non-diff thread. */
  path: string | null
  /** Line the thread is anchored to, or null. */
  line: number | null
  /** Whether the thread's latest comment was authored by the cat-factory bot itself. */
  isBot: boolean
  /** Epoch ms of the newest comment in the thread (drives the grace window). */
  latestCommentAt: number
}

/** A general (non-diff) PR conversation comment, normalized. */
export interface PullRequestComment {
  /** GitHub comment id. */
  id: string
  /** Commenter login, or '' when unknown. */
  author: string
  /** Comment body (GitHub Markdown). */
  body: string
  /** Epoch ms when the comment was created. */
  createdAt: number
  /** Whether the comment was authored by the cat-factory bot itself. */
  isBot: boolean
}

/** The normalized PR-review read the `human-review` gate classifies. */
export interface PullRequestReviewSnapshot {
  /** The PR head commit; null when no PR/branch resolved (the engine treats this as "nothing to gate"). */
  headSha: string | null
  /**
   * How many approving reviews GitHub's branch protection requires before merge
   * (`required_pull_request_reviews.required_approving_review_count`). Defaults to 1 when the
   * setting is unreadable (no protection / no admin access).
   */
  requiredApprovingReviewCount: number
  /** Logins of the PR's currently-requested (assigned) reviewers. */
  assignedReviewers: string[]
  /**
   * Count of distinct reviewers whose LATEST review is APPROVED and is not superseded by a
   * later CHANGES_REQUESTED / DISMISSED. The gate counts the PR approved when this is ≥1 and
   * ≥ {@link requiredApprovingReviewCount}.
   */
  approvals: number
  /** Open (unresolved) review threads on the PR, oldest→newest by latest comment. */
  unresolvedThreads: ReviewThread[]
  /** General PR conversation comments, oldest→newest. */
  comments: PullRequestComment[]
}

export interface PullRequestReviewProvider {
  /**
   * Resolve the block's open PR and read its human-review state (required approvals,
   * assigned reviewers, approval count, unresolved review threads + comments). Returns
   * `{ headSha: null, ... }` when the block has no resolvable PR yet (the engine treats this
   * as "nothing to gate" and the gate advances).
   */
  getReview(workspaceId: string, blockId: string): Promise<PullRequestReviewSnapshot>
  /**
   * RESOLVE the given review threads on GitHub after a `fixer` round addressed them, so the
   * gate's next probe counts them as resolved. The resolve is performed BEFORE the (optional)
   * `reply` so a failed resolve never leaves a bot reply as the thread's latest comment (which
   * would hide a still-unresolved thread from the gate's outstanding set). A non-empty `reply`
   * is posted on each successfully-resolved thread; an EMPTY `reply` means "resolve only" (used
   * by the gate's reconcile retry, which must not re-post the courtesy reply). Best-effort per
   * thread; a failure on one thread must not throw.
   */
  resolveThreads(
    workspaceId: string,
    blockId: string,
    threadIds: string[],
    reply: string,
  ): Promise<void>
}
