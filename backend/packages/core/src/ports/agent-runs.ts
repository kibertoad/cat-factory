import type { AgentRunKind } from '../domain/types'

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
   */
  listStale(olderThanEpochMs: number): Promise<AgentRunRef[]>
}
