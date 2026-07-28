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
  /** Force-write a review, bumping its `rev` (seeding / the insert behind {@link replaceForBlock}). */
  upsert(workspaceId: string, review: ClarityReview): Promise<void>
  /**
   * Rev-guarded conditional update — the clarity mirror of
   * `RequirementReviewRepository.compareAndSwap`, with the same never-inserts contract.
   */
  compareAndSwap(workspaceId: string, review: ClarityReview): Promise<boolean>
  /**
   * ATOMICALLY make `review` the block's one live review (a single conflict-targeted upsert
   * against the UNIQUE block index) — the clarity mirror of
   * `RequirementReviewRepository.replaceForBlock`, including why a transactioned
   * delete-then-insert is NOT an acceptable implementation.
   */
  replaceForBlock(workspaceId: string, review: ClarityReview): Promise<void>
}
