import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type {
  RequirementRecommendation,
  RequirementReview,
  RequirementReviewItem,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface RequirementReviewRow {
  id: string
  block_id: string
  status: string
  items: string
  model: string | null
  incorporated_requirements: string | null
  iteration: number
  max_iterations: number
  recommendations: string | null
  rev: number | null
  created_at: number
  updated_at: number
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

function rowToReview(row: RequirementReviewRow): RequirementReview {
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as RequirementReview['status'],
    items: parseJsonArray<RequirementReviewItem>(row.items),
    model: row.model,
    incorporatedRequirements: row.incorporated_requirements,
    iteration: row.iteration,
    maxIterations: row.max_iterations,
    recommendations: parseJsonArray<RequirementRecommendation>(row.recommendations),
    rev: row.rev ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Requirements reviews, stored one row per review in `requirement_reviews`
 * (migration 0021). The reviewed items live as a JSON array in `items`; a block holds at most
 * ONE live review, which {@link replaceForBlock} maintains atomically, so `getByBlock` returns
 * it. Every read-modify-write rides the rev-guarded {@link compareAndSwap} (migration 0065) —
 * the whole row is one blob, so a blind write would drop a concurrent editor's answer.
 */
export class D1RequirementReviewRepository implements RequirementReviewRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM requirement_reviews
           WHERE workspace_id = ? AND block_id = ?
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId)
      .first<RequirementReviewRow>()
    return row ? rowToReview(row) : null
  }

  async get(workspaceId: string, id: string): Promise<RequirementReview | null> {
    const row = await this.db
      .prepare(`SELECT * FROM requirement_reviews WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<RequirementReviewRow>()
    return row ? rowToReview(row) : null
  }

  private insertStatement(workspaceId: string, review: RequirementReview) {
    // A fresh insert starts at rev 0; a force-write over an existing row BUMPS it, so a
    // concurrent compareAndSwap holding the old revision still detects that the row moved.
    return this.db
      .prepare(
        `INSERT INTO requirement_reviews
           (workspace_id, id, block_id, status, items, model, incorporated_requirements,
            iteration, max_iterations, recommendations, rev, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           incorporated_requirements = excluded.incorporated_requirements,
           iteration = excluded.iteration,
           max_iterations = excluded.max_iterations,
           recommendations = excluded.recommendations,
           rev = requirement_reviews.rev + 1,
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
        review.incorporatedRequirements,
        review.iteration ?? 1,
        review.maxIterations ?? 1,
        JSON.stringify(review.recommendations ?? []),
        review.createdAt,
        review.updatedAt,
      )
  }

  async upsert(workspaceId: string, review: RequirementReview): Promise<void> {
    const row = await this.insertStatement(workspaceId, review).first<{ rev: number }>()
    if (row) review.rev = row.rev
  }

  async compareAndSwap(workspaceId: string, review: RequirementReview): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this review; writes only while the
    // stored row is unchanged, and never inserts (a deleted review must stay deleted).
    const expected = review.rev ?? 0
    const row = await this.db
      .prepare(
        `UPDATE requirement_reviews SET
           block_id = ?,
           status = ?,
           items = ?,
           model = ?,
           incorporated_requirements = ?,
           iteration = ?,
           max_iterations = ?,
           recommendations = ?,
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
        review.incorporatedRequirements,
        review.iteration ?? 1,
        review.maxIterations ?? 1,
        JSON.stringify(review.recommendations ?? []),
        review.updatedAt,
        workspaceId,
        review.id,
        expected,
      )
      .first<{ rev: number }>()
    if (!row) return false
    review.rev = row.rev
    return true
  }

  async replaceForBlock(workspaceId: string, review: RequirementReview): Promise<void> {
    // ONE transaction: `db.batch` so a second review run for the same block can't interleave
    // its delete between this delete and this insert and leave two live reviews behind.
    await this.db.batch([
      this.db
        .prepare(`DELETE FROM requirement_reviews WHERE workspace_id = ? AND block_id = ?`)
        .bind(workspaceId, review.blockId),
      this.insertStatement(workspaceId, review),
    ])
    review.rev = 0
  }
}
