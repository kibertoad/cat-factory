// Persistence port for the refined-requirements writeback marker: one row per
// `(workspace, review, linked issue, document)`, recording whether that exact document has been
// posted onto that issue as a comment.
//
// The post is a human action, but a double click, a retried request and two teammates clicking at
// once all reach the tracker the same way a replay would, and each would leave a duplicate copy of
// a long document on someone's issue. So the claim is taken BEFORE the comment is attempted, as
// one atomic insert-or-conditional-update, exactly like `ReviewQuestionPostRepository`.
//
// The document is part of the key through its hash: a later incorporation produces a different
// document, which is a new post, while the same document is posted to an issue at most once.
// `failed` is re-claimable (a tracker outage is retried by posting again), `posted` is terminal,
// and `pending` becomes re-claimable once older than REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS so a
// poster that died mid-post cannot block the document forever.

/** Identifies one refined-requirements marker. */
export interface RefinedRequirementsPostKey {
  workspaceId: string
  /** The requirements review the document belongs to. */
  reviewId: string
  /** The linked issue as `<source>:<externalId>`, the task projection's natural key. */
  issueRef: string
  /** Lowercase hex SHA-256 of the posted document, so a revised document posts again. */
  documentHash: string
}

/** Delivery state of one marker. */
export type RefinedRequirementsPostStatus = 'pending' | 'posted' | 'failed'

export interface RefinedRequirementsPostRecord extends RefinedRequirementsPostKey {
  status: RefinedRequirementsPostStatus
  /** How many claims have been taken for this key. */
  attempts: number
  /** The last failure's message, scrubbed and truncated; null unless `status` is `failed`. */
  error: string | null
  updatedAt: number
}

/** How long a `pending` claim may sit before another attempt may take it over. */
export const REFINED_REQUIREMENTS_POST_CLAIM_TTL_MS = 10 * 60_000

/** The instant a claim is taken, plus the cutoff at which an abandoned claim may be stolen. */
export interface RefinedRequirementsPostClaimWindow {
  now: number
  /** `pending` claims at or before this instant are abandoned and may be re-taken. */
  reclaimPendingBefore: number
}

export interface RefinedRequirementsPostRepository {
  /**
   * Atomically take ownership of posting this key's comment. `true` when the marker did not
   * exist, was `failed`, or was an abandoned `pending`; `false` when it is `posted` or a live
   * `pending`, and the caller must then NOT post.
   */
  claim(
    key: RefinedRequirementsPostKey,
    window: RefinedRequirementsPostClaimWindow,
  ): Promise<boolean>
  /** Record the outcome of a claimed post. */
  settle(
    key: RefinedRequirementsPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void>
  /** Read a marker back, to tell `posted` from a live `pending` after a refused claim. */
  get(key: RefinedRequirementsPostKey): Promise<RefinedRequirementsPostRecord | null>
}
