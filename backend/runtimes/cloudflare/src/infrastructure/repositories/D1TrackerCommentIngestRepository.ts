import type {
  TaskSourceKind,
  TrackerCommentIngestClaimWindow,
  TrackerCommentIngestKey,
  TrackerCommentIngestRecord,
  TrackerCommentIngestRepository,
  TrackerCommentIngestStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TrackerCommentIngestRow {
  workspace_id: string
  source: string
  external_id: string
  comment_id: string
  status: string
  attempts: number
  error: string | null
  updated_at: number
}

/**
 * Idempotency markers for inbound tracker comments, one row per
 * `(workspace, source, externalId, commentId)` (migration 0064).
 *
 * {@link claim} is a single atomic statement on purpose: an insert that, on conflict, only updates
 * a row already marked `failed` (or a `pending` one abandoned by an ingester that died mid-apply),
 * with `RETURNING` reporting whether either half fired. A read-then-write would let two concurrent
 * deliveries of the same comment both decide to apply it.
 */
export class D1TrackerCommentIngestRepository implements TrackerCommentIngestRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async claim(
    key: TrackerCommentIngestKey,
    window: TrackerCommentIngestClaimWindow,
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO tracker_comment_ingests
           (workspace_id, source, external_id, comment_id, status, attempts, error, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 1, NULL, ?)
         ON CONFLICT (workspace_id, source, external_id, comment_id) DO UPDATE SET
           status = 'pending',
           attempts = tracker_comment_ingests.attempts + 1,
           error = NULL,
           updated_at = excluded.updated_at
         WHERE tracker_comment_ingests.status = 'failed'
            OR (tracker_comment_ingests.status = 'pending'
                AND tracker_comment_ingests.updated_at <= ?)
         RETURNING comment_id`,
      )
      .bind(
        key.workspaceId,
        key.source,
        key.externalId,
        key.commentId,
        window.now,
        window.reclaimPendingBefore,
      )
      .first<{ comment_id: string }>()
    return row != null
  }

  async settle(
    key: TrackerCommentIngestKey,
    outcome: { status: 'applied' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tracker_comment_ingests
            SET status = ?, error = ?, updated_at = ?
          WHERE workspace_id = ? AND source = ? AND external_id = ? AND comment_id = ?`,
      )
      .bind(
        outcome.status,
        outcome.status === 'failed' ? outcome.error : null,
        now,
        key.workspaceId,
        key.source,
        key.externalId,
        key.commentId,
      )
      .run()
  }

  async get(key: TrackerCommentIngestKey): Promise<TrackerCommentIngestRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM tracker_comment_ingests
          WHERE workspace_id = ? AND source = ? AND external_id = ? AND comment_id = ?`,
      )
      .bind(key.workspaceId, key.source, key.externalId, key.commentId)
      .first<TrackerCommentIngestRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      externalId: row.external_id,
      commentId: row.comment_id,
      status: row.status as TrackerCommentIngestStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}
