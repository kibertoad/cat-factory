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
  /**
   * How many times a sweeper has already re-driven this run (0 for one that never has been).
   * PERSISTED rather than held in the sweeper's per-process `orphanedSince` map, which is the
   * whole point: that map is lost on a restart and, on Cloudflare, on every isolate eviction,
   * so "was this run re-driven three times or is this the first?" was answerable only by
   * grepping logs — and on the Worker not even that, since the sweep logs aggregates with no
   * run ids. A run that recovers keeps its count: the fact that it needed three re-drives is
   * exactly what an operator wants after it finally succeeds.
   */
  redriveCount: number
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
   * Every EXECUTION run currently `paused` by the spend safeguard, across all workspaces. A
   * paused run is not `running`, so {@link listStale} deliberately skips it; the Node/local
   * facade polls this on its reclaim tick to auto-resume runs whose monthly budget has since
   * freed (the Cloudflare facade needs no equivalent read — its paused run's Workflows instance
   * stays parked on a `waitForEvent` and re-checks the budget itself).
   */
  listPausedExecutions(): Promise<AgentRunRef[]>
  /**
   * The subset of the given run ids that are still LIVE — i.e. not terminal (a run in
   * `running`/`blocked`/`paused`/`pending`/`awaiting_review`, not `done`/`failed`/etc.).
   * A bootstrap parked on its adoption review is live: it has produced nothing yet and a
   * human is expected to release it, so reaping against it would be reaping against a run
   * that is still going to run. Spans workspaces
   * and batches (chunked `IN`), so local mode can reap per-run containers whose run has
   * since gone terminal or away in a single query rather than a point-read per container.
   */
  liveRunIds(ids: string[]): Promise<string[]>
  /**
   * Record that a sweeper re-drove this run: increment `redrive_count` and return the NEW
   * total. Deliberately NOT part of the re-drive's own transaction and deliberately not
   * rev-guarded — it is a monotonic counter about the run rather than a value derived from
   * the run's state, so two racing sweepers double-counting is a far better failure than a
   * lost update, and a `rev` bump here would collide with the driver's own writes and make
   * bookkeeping able to fail a re-drive.
   *
   * Returns 0 for a run that has since vanished, so a caller can tell "counted" from
   * "nothing to count" without a second read.
   */
  recordRedrive(workspaceId: string, id: string): Promise<number>
}
