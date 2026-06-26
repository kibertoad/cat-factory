import type {
  GateStepState,
  PullRequestComment,
  PullRequestReviewSnapshot,
  ReviewThread,
} from '@cat-factory/kernel'

// Pure classification logic for the `human-review` gate. Mirrors `ci.logic.ts` /
// `release.logic.ts`: a deterministic reduction over the normalized PR-review snapshot + the
// live gate state, runtime-neutral and trivially unit-testable. The gate's `probe()` maps the
// verdict to a GateProbe; the engine drives dispatch/advance/wait from there.

/** What the gate should do this poll. */
export type HumanReviewVerdict =
  /** The PR is approved with nothing outstanding — finish the gate and advance. */
  | { kind: 'advance'; reason: string }
  /**
   * Outstanding review feedback needs the fixer: `instructions` are folded into its prompt;
   * `threadIds` are the GitHub review threads to resolve once it's done; `latestCommentAt` is
   * the newest plain-comment timestamp covered, stamped onto the gate state so those comments
   * don't re-trigger.
   */
  | { kind: 'dispatch'; instructions: string; threadIds: string[]; latestCommentAt: number | null }
  /** Nothing actionable yet (awaiting the reviewer, or inside the grace window) — keep waiting. */
  | { kind: 'wait'; reason: string }

/**
 * How many approving reviews the PR needs. The `human-review` gate is OPT-IN — a team only adds
 * it to a pipeline because they want a human to sign off — so it ALWAYS requires at least one
 * approval, even when GitHub's branch protection requires fewer (a repo with `0` required reviews,
 * or an unreadable protection rule that the provider defaults to `1`). Otherwise the gate would
 * advance with no human approval at all, defeating its entire purpose.
 */
export function requiredApprovals(snapshot: PullRequestReviewSnapshot): number {
  return Math.max(1, snapshot.requiredApprovingReviewCount)
}

/** Whether the PR meets the required number of assigned-reviewer approvals. */
export function isApproved(snapshot: PullRequestReviewSnapshot): boolean {
  return snapshot.approvals >= requiredApprovals(snapshot)
}

/**
 * Unresolved review threads that need work: every unresolved thread whose LATEST comment is NOT
 * the bot's. Excluding bot-latest threads prevents re-dispatching on a thread the fixer just
 * replied to (a resolve that lagged); a reviewer re-opening with a fresh human comment flips the
 * latest author back and makes it outstanding again.
 */
export function outstandingThreads(snapshot: PullRequestReviewSnapshot): ReviewThread[] {
  return snapshot.unresolvedThreads.filter((t) => !t.isBot)
}

/** Plain conversation comments not yet handed to the fixer (newer than the last addressed). */
export function outstandingComments(
  snapshot: PullRequestReviewSnapshot,
  lastAddressedCommentAt: number | null | undefined,
): PullRequestComment[] {
  const since = lastAddressedCommentAt ?? 0
  return snapshot.comments.filter((c) => !c.isBot && c.createdAt > since)
}

/** The newest "comment" timestamp across the outstanding threads + plain comments (for grace). */
function latestOutstandingAt(threads: ReviewThread[], comments: PullRequestComment[]): number {
  let max = 0
  for (const t of threads) if (t.latestCommentAt > max) max = t.latestCommentAt
  for (const c of comments) if (c.createdAt > max) max = c.createdAt
  return max
}

/** Render the outstanding feedback into the instruction block folded into the fixer's prompt. */
export function renderReviewFeedbackForFixer(
  threads: ReviewThread[],
  comments: PullRequestComment[],
): string {
  const lines: string[] = [
    'A human reviewer left the feedback below on this pull request.',
    'Address every item, commit your fixes to the PR branch, and for each review thread post a',
    'short reply noting how you addressed it so the thread can be resolved.',
    '',
  ]
  if (threads.length > 0) {
    lines.push('Review threads:')
    for (const t of threads) {
      const where = t.path ? ` (${t.path}${t.line != null ? `:${t.line}` : ''})` : ''
      lines.push(`- ${t.author || 'reviewer'}${where}: ${t.bodyExcerpt}`)
    }
    lines.push('')
  }
  if (comments.length > 0) {
    lines.push('PR comments:')
    for (const c of comments) lines.push(`- ${c.author || 'reviewer'}: ${c.body}`)
    lines.push('')
  }
  return lines.join('\n').trim()
}

/**
 * Decide what the human-review gate does this poll. See the decision table:
 *  1. No PR → advance (nothing to gate).
 *  2. Approved + nothing outstanding → advance.
 *  3. Outstanding feedback:
 *     - approved → dispatch the fixer immediately (the reviewer signed off; just clear comments).
 *     - not approved → dispatch once the grace window has elapsed since the latest comment;
 *       otherwise wait (let the reviewer finish a series of comments before churning the branch).
 *  4. Not approved + nothing outstanding → wait (the reviewer hasn't acted / hasn't approved).
 *
 * Plain conversation comments are LOW-signal, so they count as actionable only while the PR is
 * NOT yet approved (the reviewer is still iterating and may drop an instruction in the thread).
 * Once approved, only explicit unresolved review THREADS trigger a fix — a casual "lgtm"/"thanks"
 * after sign-off must never churn the branch with a pointless fixer round. A human can always
 * force a change post-approval via the freeform request-fix control.
 */
export function classifyHumanReview(
  snapshot: PullRequestReviewSnapshot,
  gateState: Pick<GateStepState, 'lastAddressedCommentAt'>,
  opts: { graceMinutes: number; now: number },
): HumanReviewVerdict {
  if (snapshot.headSha === null) {
    return { kind: 'advance', reason: 'No open PR to review.' }
  }
  const threads = outstandingThreads(snapshot)
  const approved = isApproved(snapshot)
  const comments = approved ? [] : outstandingComments(snapshot, gateState.lastAddressedCommentAt)
  const hasOutstanding = threads.length > 0 || comments.length > 0

  if (!hasOutstanding) {
    return approved
      ? {
          kind: 'advance',
          reason: `Approved by ${snapshot.approvals} reviewer(s) with no unresolved review threads.`,
        }
      : { kind: 'wait', reason: 'Awaiting a human approval on the PR.' }
  }

  const dispatch = (): HumanReviewVerdict => ({
    kind: 'dispatch',
    instructions: renderReviewFeedbackForFixer(threads, comments),
    threadIds: threads.map((t) => t.threadId),
    latestCommentAt: comments.length > 0 ? Math.max(...comments.map((c) => c.createdAt)) : null,
  })

  if (approved) return dispatch()

  const graceElapsed =
    opts.now - latestOutstandingAt(threads, comments) >= opts.graceMinutes * 60_000
  return graceElapsed
    ? dispatch()
    : { kind: 'wait', reason: 'Review comments left; waiting out the grace window before fixing.' }
}
