import type { ClarityReview } from '../domain/types.js'

// Persistence port for the clarity-review (bug-report triage) feature. Mirrors the
// requirements-review repository: rows scoped by workspace, keyed by review id, with
// at most one *live* review per block (a new review for a block replaces the previous
// one, so `getByBlock` always returns the current review). Implemented by D1 on the
// Cloudflare facade and by Drizzle/Postgres on the Node facade.

export interface ClarityReviewRepository {
  /** The current review for a block, or null if none has been run. */
  getByBlock(workspaceId: string, blockId: string): Promise<ClarityReview | null>
  /** A review by its id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<ClarityReview | null>
  /** Create or replace a review (the service deletes a block's prior review first). */
  upsert(workspaceId: string, review: ClarityReview): Promise<void>
  /** Drop any existing review(s) for a block (called before a fresh review run). */
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
}
