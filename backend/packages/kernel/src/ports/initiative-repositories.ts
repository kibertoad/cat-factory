import type { Initiative } from '../domain/types.js'

// Persistence port for initiatives (the long-running multi-task work container).
// Rows are scoped by workspace and keyed by initiative id, with exactly one
// initiative per `initiative`-level block (a UNIQUE (workspace_id, block_id)
// constraint). Every write after the insert goes through `compareAndSwap` so the
// execution loop is a single writer by construction: a concurrent ticker whose
// `rev` is stale loses the swap and simply abandons its tick.

export interface InitiativeRepository {
  /** An initiative by its id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<Initiative | null>
  /** The initiative anchored to a board block, or null. */
  getByBlock(workspaceId: string, blockId: string): Promise<Initiative | null>
  /** Every initiative of a workspace (snapshot assembly). */
  list(workspaceId: string): Promise<Initiative[]>
  /**
   * Every `executing` initiative across ALL workspaces — the cron sweeper's work
   * list (mirrors the recurring-pipeline due-schedule read).
   */
  listExecuting(): Promise<Initiative[]>
  /** Insert a fresh initiative (rev 0). Throws on a duplicate block anchor. */
  insert(workspaceId: string, initiative: Initiative): Promise<void>
  /**
   * Optimistic-concurrency write: persists `next` (with `next.rev` already bumped
   * by the caller) ONLY if the stored row still carries `expectedRev`. Returns
   * true when the swap won, false when the row moved on (or vanished) — the
   * caller then abandons its stale mutation.
   */
  compareAndSwap(workspaceId: string, next: Initiative, expectedRev: number): Promise<boolean>
  /** Delete an initiative (when its anchor block is removed). */
  delete(workspaceId: string, id: string): Promise<void>
}
