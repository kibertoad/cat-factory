// Persistence port for the headless clarification loop's question-writeback marker: one row
// per `(workspace, review, iteration, linked issue)`, recording whether that iteration's open
// findings have been posted onto that issue.
//
// It exists because the question post is driven from the DURABLE driver, whose steps replay:
// without a marker, every replay of a parked review's gate step would post the same findings
// again, spamming the issue the reporter is reading. The claim below is atomic (an
// insert-or-conditionally-update returning whether the caller now owns the post), so the
// marker is taken BEFORE the comment is attempted rather than after — a crash between the
// post and the marker write would otherwise re-post on the next replay.
//
// A `failed` row is deliberately re-claimable: a tracker outage should be retried on the next
// replay, whereas a `posted` row is terminal for that iteration. A `pending` row is re-claimable
// only once it is old enough to be ABANDONED rather than in-flight (see
// REVIEW_QUESTION_POST_CLAIM_TTL_MS) — otherwise a poster killed mid-post would silence that
// iteration's questions forever, trading a double-post for a never-post. The row also keeps the
// last error so an operator can see WHY an issue never received its questions.

/** Identifies one posted-questions marker. */
export interface ReviewQuestionPostKey {
  workspaceId: string
  /** The parked review's id. */
  reviewId: string
  /** The review's iteration number, so each reviewer pass posts exactly once. */
  iteration: number
  /**
   * The linked issue the comment goes on, as its source-qualified external id
   * (`<source>:<externalId>`, e.g. `github:acme/api#42`) — the tracker task projection's
   * natural key, so the marker is stable across a task re-import.
   */
  issueRef: string
}

/** Delivery state of one marker. */
export type ReviewQuestionPostStatus = 'pending' | 'posted' | 'failed'

export interface ReviewQuestionPostRecord extends ReviewQuestionPostKey {
  status: ReviewQuestionPostStatus
  /** How many times a post has been attempted for this key (claims, not HTTP retries). */
  attempts: number
  /** The last failure's message, truncated; null unless `status` is `failed`. */
  error: string | null
  updatedAt: number
}

/**
 * How long a `pending` claim may sit before another attempt may take it over.
 *
 * A claim is taken BEFORE the comment is attempted, so a process that dies mid-post (an evicted
 * isolate, a killed durable step, a worker restart) leaves a `pending` row nobody will ever
 * settle. Without a takeover window that row is terminal in practice: the questions are never
 * posted and — worse — nothing ever retries, which is precisely the silent failure the marker
 * exists to make impossible. The window makes the guarantee "exactly once unless the poster
 * dies, then at-least-once after {@link REVIEW_QUESTION_POST_CLAIM_TTL_MS}".
 *
 * Sized well above the writeback's own per-issue deadline (a live post settles its row in
 * seconds, so a `pending` row this old means the poster is gone, not slow) and well below a
 * human's turnaround on the question, so a takeover cannot race a still-running post.
 */
export const REVIEW_QUESTION_POST_CLAIM_TTL_MS = 10 * 60_000

/** The instant a claim is taken, plus the cutoff at which an abandoned claim may be stolen. */
export interface ReviewQuestionPostClaimWindow {
  /** Wall clock now — stamped onto the row. */
  now: number
  /**
   * Claims still `pending` at or before this instant are treated as ABANDONED and may be
   * re-taken. Callers derive it as `now - REVIEW_QUESTION_POST_CLAIM_TTL_MS`; passing it in
   * (rather than letting each repository subtract its own constant) keeps the policy in ONE
   * place and leaves the two dialects purely mechanical.
   */
  reclaimPendingBefore: number
}

export interface ReviewQuestionPostRepository {
  /**
   * Atomically take ownership of posting this key's comment. Returns `true` when the caller
   * now owns it — the marker did not exist, it existed in a `failed` state and is being
   * retried, or a previous claim was abandoned mid-post (see
   * {@link ReviewQuestionPostClaimWindow.reclaimPendingBefore}) — and `false` when another
   * attempt already posted it or is still mid-flight, in which case the caller must NOT post.
   */
  claim(key: ReviewQuestionPostKey, window: ReviewQuestionPostClaimWindow): Promise<boolean>
  /** Record the outcome of a claimed post. */
  settle(
    key: ReviewQuestionPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void>
  /** Read a marker back (diagnostics + tests). */
  get(key: ReviewQuestionPostKey): Promise<ReviewQuestionPostRecord | null>
}
