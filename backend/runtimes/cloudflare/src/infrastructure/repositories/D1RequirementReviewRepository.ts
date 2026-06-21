import type { RequirementReviewRepository } from '@cat-factory/kernel'
import type { RequirementReview, RequirementReviewItem } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface RequirementReviewRow {
  id: string
  block_id: string
  status: string
  items: string
  model: string | null
  incorporated_requirements: string | null
  companion: string | null
  created_at: number
  updated_at: number
}

function rowToReview(row: RequirementReviewRow): RequirementReview {
  let items: RequirementReviewItem[] = []
  try {
    const parsed = JSON.parse(row.items)
    if (Array.isArray(parsed)) items = parsed as RequirementReviewItem[]
  } catch {
    items = []
  }
  let companionVerdicts: RequirementReview['companionVerdicts'] = []
  if (row.companion) {
    try {
      const parsed = JSON.parse(row.companion)
      if (Array.isArray(parsed)) companionVerdicts = parsed as RequirementReview['companionVerdicts']
    } catch {
      companionVerdicts = []
    }
  }
  return {
    id: row.id,
    blockId: row.block_id,
    status: row.status as RequirementReview['status'],
    items,
    model: row.model,
    incorporatedRequirements: row.incorporated_requirements,
    companionVerdicts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Requirements reviews, stored one row per review in `requirement_reviews`
 * (migration 0021). The reviewed items live as a JSON array in `items`; the
 * service keeps at most one live review per block (it deletes the block's prior
 * review before inserting a fresh one), so `getByBlock` returns the latest.
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

  async upsert(workspaceId: string, review: RequirementReview): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO requirement_reviews
           (workspace_id, id, block_id, status, items, model, incorporated_requirements,
            companion, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           items = excluded.items,
           model = excluded.model,
           incorporated_requirements = excluded.incorporated_requirements,
           companion = excluded.companion,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        review.id,
        review.blockId,
        review.status,
        JSON.stringify(review.items),
        review.model,
        review.incorporatedRequirements,
        review.companionVerdicts?.length ? JSON.stringify(review.companionVerdicts) : null,
        review.createdAt,
        review.updatedAt,
      )
      .run()
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM requirement_reviews WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .run()
  }
}
