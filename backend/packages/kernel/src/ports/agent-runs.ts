import type { AgentRunKind } from '../domain/types.js'

/**
 * A lightweight, kind-tagged reference to an entry in the unified `agent_runs`
 * table. Used by cross-kind machinery — the cron sweeper (re-drive any stale run
 * via the right durable workflow) and the unified retry endpoint (dispatch to the
 * right service) — without coupling them to either flow's full record shape.
 */
export interface AgentRunRef {
  workspaceId: string
  id: string
  kind: AgentRunKind
}

/**
 * A stale-run candidate: an {@link AgentRunRef} plus the run's `updated_at` lease
 * timestamp (epoch ms). The sweeper needs the age to tell a run that is merely
 * behind its short lease (re-drive it) from one that has been orphaned past the
 * hard-stall deadline (give up and flag it `stalled`).
 */
export interface StaleAgentRun extends AgentRunRef {
  updatedAt: number
}

/**
 * Read-only, kind-spanning view over `agent_runs`. The per-flow repositories
 * ({@link ExecutionRepository}, BootstrapJobRepository) own writes scoped to their
 * own kind; this port answers the two questions that span both kinds.
 */
export interface AgentRunRepository {
  /** The kind of a run (to dispatch a retry), or null if no such run exists. */
  getRef(workspaceId: string, id: string): Promise<AgentRunRef | null>
  /**
   * Runs of any kind still marked `running` whose lease (`updated_at`) is older
   * than the given epoch-ms cutoff — candidates the durable driver may have
   * dropped. Spans all workspaces so a single cron pass repairs the whole system.
   * Each carries its `updatedAt` so the sweeper can escalate a long-orphaned run.
   */
  listStale(olderThanEpochMs: number): Promise<StaleAgentRun[]>
  /**
   * The subset of the given run ids that are still LIVE — i.e. not terminal (a run in
   * `running`/`blocked`/`paused`/`pending`, not `done`/`failed`/etc.). Spans workspaces
   * and batches (chunked `IN`), so local mode can reap per-run containers whose run has
   * since gone terminal or away in a single query rather than a point-read per container.
   */
  liveRunIds(ids: string[]): Promise<string[]>
}
