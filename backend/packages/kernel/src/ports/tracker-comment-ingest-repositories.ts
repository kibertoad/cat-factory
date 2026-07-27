import type { TaskSourceKind } from '../domain/types.js'

// Persistence port for the tracker-comment ingest marker: one row per
// `(workspace, source, externalId, commentId)`, recording whether that comment's review-reply
// commands have been applied.
//
// It exists because a tracker redelivers. Every vendor here retries a delivery the receiver
// failed to ack, the reconciliation sweep can overlap a live delivery, and a queued job is
// retried by pg-boss / the CF queue on any error — so without a marker one reporter comment
// would answer the same finding several times, each answer re-entering the incorporation
// prompt as if the human had said it twice.
//
// The claim below is atomic (an insert-or-conditionally-update reporting whether the caller now
// owns the ingest) and is taken BEFORE anything is applied, not after: a crash between applying
// the reply and writing the marker would otherwise re-apply on the next delivery. This is the
// same shape as `review_question_posts` — deliberately, per that port's own note ("Slice 2b's
// cursor dedup is the same shape — copy the marker repo, don't invent a read-then-write").
//
// A `failed` row is re-claimable so a transient outage is retried; an `applied` row is terminal.
// A `pending` row is re-claimable only once ABANDONED (see TRACKER_COMMENT_INGEST_CLAIM_TTL_MS),
// because an ingester killed mid-apply must not silence that comment forever — trading a
// double-apply for a never-apply is the harder failure to notice of the two.

/** Identifies one ingested tracker comment. */
export interface TrackerCommentIngestKey {
  workspaceId: string
  /** Which tracker the comment came from — two trackers can hand out the same ids. */
  source: TaskSourceKind
  /** The issue the comment is on, as the source's canonical key. */
  externalId: string
  /** The vendor's comment id. */
  commentId: string
}

/** Delivery state of one ingest marker. */
export type TrackerCommentIngestStatus = 'pending' | 'applied' | 'failed'

export interface TrackerCommentIngestRecord extends TrackerCommentIngestKey {
  status: TrackerCommentIngestStatus
  /** How many times an apply has been attempted for this key (claims, not HTTP retries). */
  attempts: number
  /** The last failure's message, scrubbed + truncated; null unless `status` is `failed`. */
  error: string | null
  updatedAt: number
}

/**
 * How long a `pending` claim may sit before another delivery may take it over.
 *
 * Sized well above a live ingest (which settles its row in seconds — it is a handful of local
 * service calls plus one outbound comment) and well below a human's turnaround on the question,
 * so a takeover cannot race a still-running apply. Mirrors
 * {@link REVIEW_QUESTION_POST_CLAIM_TTL_MS}; the two windows are independent knobs on purpose,
 * because they bound different work.
 */
export const TRACKER_COMMENT_INGEST_CLAIM_TTL_MS = 10 * 60_000

/** The instant a claim is taken, plus the cutoff at which an abandoned claim may be stolen. */
export interface TrackerCommentIngestClaimWindow {
  /** Wall clock now — stamped onto the row. */
  now: number
  /**
   * Claims still `pending` at or before this instant are treated as ABANDONED and may be
   * re-taken. Callers derive it as `now - TRACKER_COMMENT_INGEST_CLAIM_TTL_MS`; passing it in
   * keeps the policy in ONE place and leaves the two dialects purely mechanical.
   */
  reclaimPendingBefore: number
}

export interface TrackerCommentIngestRepository {
  /**
   * Atomically take ownership of applying this comment. Returns `true` when the caller now owns
   * it — the marker did not exist, it existed `failed` and is being retried, or a previous claim
   * was abandoned mid-apply — and `false` when another delivery already applied it or is still
   * mid-flight, in which case the caller must NOT apply.
   */
  claim(key: TrackerCommentIngestKey, window: TrackerCommentIngestClaimWindow): Promise<boolean>
  /** Record the outcome of a claimed apply. */
  settle(
    key: TrackerCommentIngestKey,
    outcome: { status: 'applied' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void>
  /** Read a marker back (diagnostics + tests). */
  get(key: TrackerCommentIngestKey): Promise<TrackerCommentIngestRecord | null>
}
