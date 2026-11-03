import type {
  WritebackPostClaim,
  WritebackPostClaimWindow,
  WritebackPostKey,
  WritebackPostRecord,
  WritebackPostRepository,
  WritebackPostStatus,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface WritebackPostRow {
  status: string
  attempts: number
  error: string | null
  updated_at: number
}

const KEY_WHERE =
  'workspace_id = ? AND kind = ? AND subject_id = ? AND issue_ref = ? AND discriminator = ?'

const keyBinds = (key: WritebackPostKey) =>
  [key.workspaceId, key.kind, key.subjectId, key.issueRef, key.discriminator] as const

// Whether the existing row may be re-taken. `?8` is the abandonment cutoff; a NULL cutoff makes the
// comparison NULL, so a `pending` row is then never re-taken.
const RECLAIMABLE = `(writeback_posts.status = 'failed'
  OR (writeback_posts.status = 'pending' AND writeback_posts.updated_at <= ?8))`

/**
 * The writeback exactly-once markers (migration 0111). {@link claim} is ONE statement: the upsert
 * rewrites a conflicting row only when it is reclaimable, and otherwise leaves it as it was, so
 * `RETURNING` reports either this claim's own token (won) or the holder's state (lost). SET
 * expressions read the row as it was before the update, so every CASE sees the same predicate.
 */
export class D1WritebackPostRepository implements WritebackPostRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async claim(
    key: WritebackPostKey,
    window: WritebackPostClaimWindow,
  ): Promise<WritebackPostClaim> {
    const token = crypto.randomUUID()
    const row = await this.db
      .prepare(
        `INSERT INTO writeback_posts
           (workspace_id, kind, subject_id, issue_ref, discriminator, status, attempts, error,
            claim_token, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 1, NULL, ?6, ?7)
         ON CONFLICT (workspace_id, kind, subject_id, issue_ref, discriminator) DO UPDATE SET
           status = CASE WHEN ${RECLAIMABLE} THEN 'pending' ELSE writeback_posts.status END,
           attempts = CASE WHEN ${RECLAIMABLE} THEN writeback_posts.attempts + 1
                           ELSE writeback_posts.attempts END,
           error = CASE WHEN ${RECLAIMABLE} THEN NULL ELSE writeback_posts.error END,
           claim_token = CASE WHEN ${RECLAIMABLE} THEN excluded.claim_token
                              ELSE writeback_posts.claim_token END,
           updated_at = CASE WHEN ${RECLAIMABLE} THEN excluded.updated_at
                             ELSE writeback_posts.updated_at END
         RETURNING status, claim_token`,
      )
      .bind(...keyBinds(key), token, window.now, window.reclaimPendingBefore)
      .first<{ status: string; claim_token: string | null }>()
    if (row?.claim_token === token) return 'claimed'
    return row?.status === 'posted' ? 'posted' : 'held'
  }

  async settle(
    key: WritebackPostKey,
    outcome: { status: 'posted' } | { status: 'failed'; error: string },
    now: number,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE writeback_posts SET status = ?, error = ?, updated_at = ? WHERE ${KEY_WHERE}`,
      )
      .bind(
        outcome.status,
        outcome.status === 'failed' ? outcome.error : null,
        now,
        ...keyBinds(key),
      )
      .run()
  }

  async get(key: WritebackPostKey): Promise<WritebackPostRecord | null> {
    const row = await this.db
      .prepare(`SELECT status, attempts, error, updated_at FROM writeback_posts WHERE ${KEY_WHERE}`)
      .bind(...keyBinds(key))
      .first<WritebackPostRow>()
    if (!row) return null
    return {
      ...key,
      status: row.status as WritebackPostStatus,
      attempts: row.attempts,
      error: row.error,
      updatedAt: row.updated_at,
    }
  }
}
