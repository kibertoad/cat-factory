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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Clarity (bug-report triage) reviews, stored one row per review in `clarity_reviews`.
 * The mirror of {@link D1RequirementReviewRepository}: items live as a JSON array, the
 * service keeps at most one live review per block, so `getByBlock` returns the latest.
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

  async upsert(workspaceId: string, review: ClarityReview): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO clarity_reviews
           (workspace_id, id, block_id, status, items, model, clarified_report,
            iteration, max_iterations, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           clarified_report = excluded.clarified_report,
           iteration = excluded.iteration,
           max_iterations = excluded.max_iterations,
           updated_at = excluded.updated_at`,
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
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM clarity_reviews WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}
