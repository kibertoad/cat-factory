// Persistence port for the tracker writeback's exactly-once marker: one row per
// `(workspace, kind, subject, linked issue, discriminator)`, recording whether that comment has
// been posted onto that issue.
//
// Every writeback that must not post twice claims through this ONE port, so the atomic claim, the
// abandonment window and the cross-runtime parity are written once:
//
//  - `review_questions`: a parked review's open findings, posted from the DURABLE driver whose
//    steps replay. Subject is the review id, discriminator the iteration number.
//  - `refined_requirements`: a requirements review's revised document, posted on a person's click.
//    Subject is the review id, discriminator the document's SHA-256, so a revised document posts
//    again while the same one posts at most once.
//
// The claim is taken BEFORE the comment is attempted, as one atomic insert-or-conditional-update,
// so a replay, a double click or two teammates clicking at once cannot both post. `failed` is
// re-claimable (a tracker outage is retried), `posted` is terminal, and a `pending` row is
// re-claimable only when the CALLER passes an abandonment cutoff: a replaying driver can die
// mid-post and must self-heal, while a live poster that knows its comment landed must never let a
// stale `pending` reopen.

/**
 * Which writeback a marker belongs to. Persisted, so retiring a member leaves its rows behind and
 * needs a migration that names it.
 */
export const WRITEBACK_POST_KINDS = ['review_questions', 'refined_requirements'] as const
export type WritebackPostKind = (typeof WRITEBACK_POST_KINDS)[number]

/** Identifies one writeback marker. */
export interface WritebackPostKey {
  workspaceId: string
  kind: WritebackPostKind
  /** The entity the comment is about (a review id for both current kinds). */
  subjectId: string
  /**
   * The linked issue the comment goes on, as its source-qualified external id
   * (`<source>:<externalId>`, e.g. `github:acme/api#42`): the tracker task projection's natural
   * key, so the marker is stable across a task re-import.
   */
  issueRef: string
  /** What makes one post of this subject distinct from the next (an iteration, a document hash). */
  discriminator: string
}

/** Delivery state of one marker. */
export type WritebackPostStatus = 'pending' | 'posted' | 'failed'

export interface WritebackPostRecord extends WritebackPostKey {
  status: WritebackPostStatus
  /** How many claims have been taken for this key (claims, not HTTP retries). */
  attempts: number
  /** The last failure's message, scrubbed and truncated; null unless `status` is `failed`. */
  error: string | null
  updatedAt: number
}

/**
 * How long a `pending` claim may sit before a caller that opts into takeover may re-take it.
 *
 * Sized well above a writeback's own per-issue deadline (a live post settles its row in seconds,
 * so a `pending` row this old means the poster is gone, not slow) and well below a human's
 * turnaround on the comment, so a takeover cannot race a still-running post.
 */
export const WRITEBACK_POST_CLAIM_TTL_MS = 10 * 60_000

/** The instant a claim is taken, plus the cutoff at which an abandoned claim may be stolen. */
export interface WritebackPostClaimWindow {
  /** Wall clock now, stamped onto the row. */
  now: number
  /**
   * `pending` claims at or before this instant are ABANDONED and may be re-taken; `null` never
   * re-takes one. Callers derive it as `now - WRITEBACK_POST_CLAIM_TTL_MS`, so the policy lives in
   * the caller and the two dialects stay mechanical.
   */
  reclaimPendingBefore: number | null
}

/**
 * The answer to a claim, decided by the claiming statement itself: `claimed` means the caller now
 * owns the post; `posted` means it already landed; `held` means another claim is live (or, for a
 * caller that never re-takes, was never settled). Only `claimed` may post.
 */
export type WritebackPostClaim = 'claimed' | 'posted' | 'held'

export interface WritebackPostRepository {
  /** Atomically take ownership of posting this key's comment, in ONE statement. */
  claim(key: WritebackPostKey, window: WritebackPostClaimWindow): Promise<WritebackPostClaim>
  /** Record the outcome of a claimed post. Settling a key that was never claimed is a no-op. */
  settle(
    key: WritebackPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void>
  /** Read a marker back (diagnostics and tests). */
  get(key: WritebackPostKey): Promise<WritebackPostRecord | null>
}
