import type { RequirementReview } from '../domain/types.js'

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
   * Force-write a review, bumping its `rev`. Reserved for the paths that legitimately own
   * the row outright (seeding a review, the initial insert behind {@link replaceForBlock});
   * every read-modify-write goes through {@link compareAndSwap} instead, or it clobbers a
   * concurrent editor's answer.
   */
  upsert(workspaceId: string, review: RequirementReview): Promise<void>
  /**
   * Conditional update guarded on the `rev` the caller loaded onto `review`: writes (bumping
   * `rev` in the store AND on the passed object) only while the stored row still carries that
   * revision, and NEVER inserts. Returns false when another writer moved — or deleted — the
   * row, so the caller reloads and re-applies its mutation on the winning snapshot instead of
   * force-writing a stale whole-row snapshot over it (race-audit 2.5).
   */
  compareAndSwap(workspaceId: string, review: RequirementReview): Promise<boolean>
  /**
   * ATOMICALLY make `review` the block's one live review: drop the block's existing review(s)
   * and insert this one in a single transaction. The two halves must not be separate calls —
   * a double-submitted review run would otherwise interleave as delete/delete/insert/insert and
   * leave the block with TWO live reviews, so a parked run's decision can key to a different
   * review than the window loaded.
   */
  replaceForBlock(workspaceId: string, review: RequirementReview): Promise<void>
}
