import type { RiskPolicy, RunDefaultScope } from '../domain/types.js'

// Persistence port for per-workspace merge threshold presets. The worker
// implements it against D1; tests supply an in-memory fake. A workspace carries TWO
// defaults, one per `RunDefaultScope`: `isDefault` for a run somebody started in the app
// and `isUnattendedDefault` for one nothing is watching, each resolved for any task that hasn't
// picked a policy. Enforcing the single-default invariant PER SCOPE is the repository's job
// (promoting a new default demotes the previous one, and only on the scope being promoted: the
// two flags are independent, so one row may hold both).

export interface RiskPolicyRepository {
  /** A preset by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<RiskPolicy | null>
  /** All presets for a workspace (for the snapshot + settings UI). */
  list(workspaceId: string): Promise<RiskPolicy[]>
  /**
   * The workspace's default preset for one scope, or null if none is seeded yet.
   *
   * The scope is REQUIRED rather than defaulted, so a caller that has not decided which kind of
   * run it is resolving for fails to compile. The alternative reads as correct and silently hands
   * an unwatched run the in-app policy, which is the exact behaviour this parameter exists to fix.
   */
  getDefault(workspaceId: string, scope: RunDefaultScope): Promise<RiskPolicy | null>
  /**
   * Create or replace a preset (keyed by id). Promoting `isDefault` / `isUnattendedDefault`
   * demotes the prior holder of THAT flag, leaving the other scope's default alone.
   */
  upsert(workspaceId: string, preset: RiskPolicy): Promise<void>
  /** Remove a preset by id (no-op if absent). Neither scope's default preset can be removed. */
  remove(workspaceId: string, id: string): Promise<void>
}
