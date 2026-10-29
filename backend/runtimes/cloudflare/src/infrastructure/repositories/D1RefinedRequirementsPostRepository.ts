import type {
  RefinedRequirementsPostClaimWindow,
  RefinedRequirementsPostKey,
  RefinedRequirementsPostRecord,
  RefinedRequirementsPostRepository,
  RefinedRequirementsPostStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface RefinedRequirementsPostRow {
  workspace_id: string
  review_id: string
  issue_ref: string
  document_hash: string
  status: string
  attempts: number
  error: string | null
  updated_at: number
}

const KEY_WHERE = 'workspace_id = ? AND review_id = ? AND issue_ref = ? AND document_hash = ?'

const keyBinds = (key: RefinedRequirementsPostKey) =>
  [key.workspaceId, key.reviewId, key.issueRef, key.documentHash] as const

/**
 * Idempotency markers for posting refined requirements to a linked issue (migration 0111). The
 * claim is one atomic statement, as in `D1ReviewQuestionPostRepository`: a read-then-write would
 * let two concurrent requests both decide to post.
 */
export class D1RefinedRequirementsPostRepository implements RefinedRequirementsPostRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async claim(
    key: RefinedRequirementsPostKey,
    window: RefinedRequirementsPostClaimWindow,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO refined_requirements_posts
           (workspace_id, review_id, issue_ref, document_hash, status, attempts, error, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 1, NULL, ?)
         ON CONFLICT (workspace_id, review_id, issue_ref, document_hash) DO UPDATE SET
           status = 'pending',
           attempts = refined_requirements_posts.attempts + 1,
           error = NULL,
           updated_at = excluded.updated_at
         WHERE refined_requirements_posts.status = 'failed'
            OR (refined_requirements_posts.status = 'pending'
                AND refined_requirements_posts.updated_at <= ?)
         RETURNING issue_ref`,
      )
      .bind(...keyBinds(key), window.now, window.reclaimPendingBefore)
      .first<{ issue_ref: string }>()
    return row != null
  }

  async settle(
    key: RefinedRequirementsPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE refined_requirements_posts SET status = ?, error = ?, updated_at = ? WHERE ${KEY_WHERE}`,
      )
      .bind(
        outcome.status,
        outcome.status === 'failed' ? outcome.error : null,
        now,
        ...keyBinds(key),
      )
      .run()
  }

  async get(key: RefinedRequirementsPostKey): Promise<RefinedRequirementsPostRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM refined_requirements_posts WHERE ${KEY_WHERE}`)
      .bind(...keyBinds(key))
      .first<RefinedRequirementsPostRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      reviewId: row.review_id,
      issueRef: row.issue_ref,
      documentHash: row.document_hash,
      status: row.status as RefinedRequirementsPostStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}
