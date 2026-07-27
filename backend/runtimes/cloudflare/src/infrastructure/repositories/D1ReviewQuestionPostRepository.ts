import type {
  ReviewQuestionPostClaimWindow,
  ReviewQuestionPostKey,
  ReviewQuestionPostRecord,
  ReviewQuestionPostRepository,
  ReviewQuestionPostStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ReviewQuestionPostRow {
  workspace_id: string
  review_id: string
  iteration: number
  issue_ref: string
  status: string
  attempts: number
  error: string | null
  updated_at: number
}

/**
 * Idempotency markers for the headless clarification loop's question writeback, one row per
 * `(workspace, review, iteration, linked issue)` (migration 0062).
 *
 * {@link claim} is a single atomic statement on purpose: an insert that, on conflict, only
 * updates a row already marked `failed` (or a `pending` one abandoned by a poster that died
 * mid-post), with `RETURNING` reporting whether either half fired. A read-then-write would let
 * two concurrent driver replays both decide to post.
 */
export class D1ReviewQuestionPostRepository implements ReviewQuestionPostRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async claim(key: ReviewQuestionPostKey, window: ReviewQuestionPostClaimWindow): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO review_question_posts
           (workspace_id, review_id, iteration, issue_ref, status, attempts, error, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 1, NULL, ?)
         ON CONFLICT (workspace_id, review_id, iteration, issue_ref) DO UPDATE SET
           status = 'pending',
           attempts = review_question_posts.attempts + 1,
           error = NULL,
           updated_at = excluded.updated_at
         WHERE review_question_posts.status = 'failed'
            OR (review_question_posts.status = 'pending'
                AND review_question_posts.updated_at <= ?)
         RETURNING issue_ref`,
      )
      .bind(
        key.workspaceId,
        key.reviewId,
        key.iteration,
        key.issueRef,
        window.now,
        window.reclaimPendingBefore,
      )
      .first<{ issue_ref: string }>()
    return row != null
  }

  async settle(
    key: ReviewQuestionPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE review_question_posts
            SET status = ?, error = ?, updated_at = ?
          WHERE workspace_id = ? AND review_id = ? AND iteration = ? AND issue_ref = ?`,
      )
      .bind(
        outcome.status,
        outcome.status === 'failed' ? outcome.error : null,
        now,
        key.workspaceId,
        key.reviewId,
        key.iteration,
        key.issueRef,
      )
      .run()
  }

  async get(key: ReviewQuestionPostKey): Promise<ReviewQuestionPostRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM review_question_posts
          WHERE workspace_id = ? AND review_id = ? AND iteration = ? AND issue_ref = ?`,
      )
      .bind(key.workspaceId, key.reviewId, key.iteration, key.issueRef)
      .first<ReviewQuestionPostRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      reviewId: row.review_id,
      iteration: row.iteration,
      issueRef: row.issue_ref,
      status: row.status as ReviewQuestionPostStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}
