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
// replay, whereas a `posted` row is terminal for that iteration. The row also keeps the last
// error so an operator can see WHY an issue never received its questions.

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

export interface ReviewQuestionPostRepository {
  /**
   * Atomically take ownership of posting this key's comment. Returns `true` when the caller
   * now owns it — either the marker did not exist, or it existed in a `failed` state and is
   * being retried — and `false` when another attempt already posted it or is mid-flight, in
   * which case the caller must NOT post.
   */
  claim(key: ReviewQuestionPostKey, now: number): Promise<boolean>
  /** Record the outcome of a claimed post. */
  settle(
    key: ReviewQuestionPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void>
  /** Read a marker back (diagnostics + tests). */
  get(key: ReviewQuestionPostKey): Promise<ReviewQuestionPostRecord | null>
}
