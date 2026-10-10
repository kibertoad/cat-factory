import type { WorkspaceAgentSettings } from '../domain/types.js'

// Persistence port for per-workspace, per-agent-kind generation settings (today: the
// output-token ceiling). The Worker implements it against D1, the Node service against
// Postgres; tests supply an in-memory fake.
//
// One row per `(workspace, agentKind)`, and unlike the prompt-override log this store is
// PLAIN: a numeric ceiling has no history worth restoring and no long text two editors
// could clobber, so it upserts rather than appending revisions. A kind with no row inherits
// the deployment routing default.
//
// The dispatch path reads ONE kind (`get`) — the kind being dispatched — so it stays a point
// read per run, not an N+1. Every surface that needs a whole pipeline's worth of kinds at
// once (the builder's badges, the settings screen) uses `list`, which is one query for the
// workspace rather than a read per step.

export interface WorkspaceAgentSettingsRepository {
  /** One kind's settings, or null when the workspace has never configured that kind. */
  get(workspaceId: string, agentKind: string): Promise<WorkspaceAgentSettings | null>
  /**
   * Every configured kind in the workspace. One query, so the pipeline builder can badge a
   * whole pipeline's steps without a point read each.
   */
  list(workspaceId: string): Promise<WorkspaceAgentSettings[]>
  /**
   * Create or replace one kind's settings, keyed `(workspace, agentKind)`.
   *
   * Upsert is correct here precisely because the value is a single scalar a human typed: a
   * lost update costs the loser's number, which they can see is wrong and retype. That is
   * the opposite of the prompt log, where last-write-wins would silently discard a body of
   * authored text — hence the append-only design there and the plain upsert here.
   */
  upsert(workspaceId: string, settings: WorkspaceAgentSettings): Promise<void>
  /** Drop one kind's row entirely, so it inherits the deployment default again. No-op if absent. */
  remove(workspaceId: string, agentKind: string): Promise<void>
}
