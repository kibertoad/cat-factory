import type { RequirementReview } from '../domain/types'

// Persistence port for the requirements-review feature. The worker implements it
// against D1 (migration 0021); tests can supply an in-memory fake. Rows are
// scoped by workspace and keyed by review id, with at most one *live* review per
// block (a new review for a block replaces the previous one, so `getByBlock`
// always returns the current review).

export interface RequirementReviewRepository {
  /** The current review for a block, or null if none has been run. */
  getByBlock(workspaceId: string, blockId: string): Promise<RequirementReview | null>
  /** A review by its id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<RequirementReview | null>
  /**
   * Create or replace a review. Replacing the block's prior review is the caller's
   * responsibility (the service deletes it before inserting a fresh one), so a
   * block never accumulates stale reviews.
   */
  upsert(workspaceId: string, review: RequirementReview): Promise<void>
  /** Drop any existing review(s) for a block (called before a fresh review run). */
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}
