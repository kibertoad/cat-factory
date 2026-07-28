import type { ClarityReviewRepository } from '@cat-factory/kernel'
import type { ClarityReview, ClarityReviewItem } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface ClarityReviewRow {
  id: string
  block_id: string
  status: string
  items: string
  model: string | null
  clarified_report: string | null
  iteration: number
  max_iterations: number
  rev: number | null
  created_at: number
  updated_at: number
}

function rowToReview(row: ClarityReviewRow): ClarityReview {
  let items: ClarityReviewItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as ClarityReviewItem[]
  } catch {
    items = []
  }
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as ClarityReview['status'],
    items,
    model: row.model,
    clarifiedReport: row.clarified_report,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    rev: row.rev ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Clarity (bug-report triage) reviews, stored one row per review in `clarity_reviews`.
 * The mirror of {@link D1RequirementReviewRepository}, down to the concurrency contract: items
 * live as a JSON array, `replaceForBlock` keeps exactly one live review per block, and every
 * read-modify-write rides the rev-guarded `compareAndSwap`.
 */
export class D1ClarityReviewRepository implements ClarityReviewRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ClarityReview | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM clarity_reviews
           WHERE workspace_id = ? AND block_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<ClarityReviewRow>()
    return row ? rowToReview(row) : null
  }

  async get(workspaceId: string, id: string): Promise<ClarityReview | null> {
    const row = await this.db
      .prepare(`SELECT * FROM clarity_reviews WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ClarityReviewRow>()
    return row ? rowToReview(row) : null
  }

  private insertStatement(workspaceId: string, review: ClarityReview) {
    // A fresh insert starts at rev 0; a force-write over an existing row BUMPS it, so a
    // concurrent compareAndSwap holding the old revision still detects that the row moved.
    return this.db
      .prepare(
        `INSERT INTO clarity_reviews
           (workspace_id, id, block_id, status, items, model, clarified_report,
            iteration, max_iterations, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           clarified_report = excluded.clarified_report,
           iteration = excluded.iteration,
           max_iterations = excluded.max_iterations,
           rev = clarity_reviews.rev + 1,
           updated_at = excluded.updated_at
         RETURNING rev`,
      )
      .bind(
        workspaceId,
        review.id,
        review.blockId,
        review.status,
        JSON.stringify(review.items),
        review.model,
        review.clarifiedReport,
        review.iteration ?? 1,
        review.maxIterations ?? 1,
        review.createdAt,
        review.updatedAt,
      )
  }

  async upsert(workspaceId: string, review: ClarityReview): Promise<void> {
    const row = await this.insertStatement(workspaceId, review).first<{ rev: number }>()
    if (row) review.rev = row.rev
  }

  async compareAndSwap(workspaceId: string, review: ClarityReview): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this review; writes only while the
    // stored row is unchanged, and never inserts (a deleted review must stay deleted).
    const row = await this.db
      .prepare(
        `UPDATE clarity_reviews SET
           block_id = ?,
           status = ?,
           items = ?,
           model = ?,
           clarified_report = ?,
           iteration = ?,
           max_iterations = ?,
           updated_at = ?,
           rev = rev + 1
         WHERE workspace_id = ? AND id = ? AND rev = ?
         RETURNING rev`,
      )
      .bind(
        review.blockId,
        review.status,
        JSON.stringify(review.items),
        review.model,
        review.clarifiedReport,
        review.iteration ?? 1,
        review.maxIterations ?? 1,
        review.updatedAt,
        workspaceId,
        review.id,
        review.rev ?? 0,
      )
      .first<{ rev: number }>()
    if (!row) return false
    review.rev = row.rev
    return true
  }

  async replaceForBlock(workspaceId: string, review: ClarityReview): Promise<void> {
    // ONE transaction: `db.batch` so a second review run for the same block can't interleave
    // its delete between this delete and this insert and leave two live reviews behind.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM clarity_reviews WHERE workspace_id = ? AND block_id = ?`)
        .bind(workspaceId, review.blockId),
      this.insertStatement(workspaceId, review),
    ])
    review.rev = 0
  }
}
