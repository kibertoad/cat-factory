import type { RiskPolicy, RunDefaultScope } from '../domain/types.js'

/**
 * An ACCOUNT-tier risk policy: every field of a stored policy except the two per-scope DEFAULT
 * claims, which an account row cannot hold.
 *
 * A default is the answer to "which policy governs a task on THIS board that pinned none", and
 * that is a per-board question: one account's boards routinely want different postures, and there
 * is no row an account could flag that would be right for all of them. So the claims stay
 * workspace-tier, the account table has no columns for them, and the type says so rather than
 * carrying two fields every reader would have to know are always false. A board that wants an
 * inherited policy as its default clones it, which is the same click and leaves a row it owns.
 */
export type AccountRiskPolicy = Omit<RiskPolicy, 'isDefault' | 'isUnattendedDefault'>

// Persistence port for per-workspace merge threshold presets. The worker
// implements it against D1; tests supply an in-memory fake. A workspace carries TWO
// defaults, one per `RunDefaultScope`: `isDefault` for a run somebody started in the app
// and `isUnattendedDefault` for one nothing is watching, each resolved for any task that hasn't
// picked a policy. Enforcing the single-default invariant PER SCOPE is the repository's job
// (promoting a new default demotes the previous one, and only on the scope being promoted: the
// two flags are independent, so one row may hold both).

/**
 * The three READS every risk-policy consumer makes about a board: one policy by id, the whole
 * library, and a scope's default.
 *
 * Named apart from the repository below because since ADR 0055 the answer is no longer one table's
 * rows: a board's library is its own policies MERGED with the account policies it inherits, and the
 * engine's resolution, the board editor and the two board guards must all read the same merged
 * view. Typing those consumers against this — rather than against the workspace-tier repository
 * they used to hold — is what makes "the picker offered it, so the engine resolves it" a property
 * of the types instead of a discipline. The workspace tier's own repository satisfies it too, which
 * is exactly what a facade with no account tier wired falls back to.
 */
export interface WorkspaceRiskPolicyReader {
  /** A policy by id, or null if nothing this board can see defines it. */
  get(workspaceId: string, id: string): Promise<RiskPolicy | null>
  /** The whole library (the snapshot, the settings editor, the board guards). */
  list(workspaceId: string): Promise<RiskPolicy[]>
  /**
   * The workspace's default preset for one scope, or null if none is seeded yet.
   *
   * The scope is REQUIRED rather than defaulted, so a caller that has not decided which kind of
   * run it is resolving for fails to compile. The alternative reads as correct and silently hands
   * an unwatched run the in-app policy, which is the exact behaviour this parameter exists to fix.
   *
   * Answered from the WORKSPACE tier alone, at either layer that implements this: an account row
   * holds no default claim (see {@link AccountRiskPolicy}).
   */
  getDefault(workspaceId: string, scope: RunDefaultScope): Promise<RiskPolicy | null>
}

export interface RiskPolicyRepository extends WorkspaceRiskPolicyReader {
  /**
   * Create or replace a preset (keyed by id). Promoting `isDefault` / `isUnattendedDefault`
   * demotes the prior holder of THAT flag, leaving the other scope's default alone.
   */
  upsert(workspaceId: string, preset: RiskPolicy): Promise<void>
  /** Remove a preset by id (no-op if absent). Neither scope's default preset can be removed. */
  remove(workspaceId: string, id: string): Promise<void>
}

/**
 * The ACCOUNT-tier policy library: postures authored once for a whole account, which every board
 * under it inherits read-only (ADR 0055). Its own table rather than a re-tiering of the workspace
 * one, because the two tiers have different LIFECYCLES: a workspace row is seeded from the built-in
 * catalog when the board is created, carries the board's default claims, and is reclaimed by the
 * board-delete cascade, none of which is true of a shared account row.
 *
 * There is no `getDefault` here on purpose (see {@link AccountRiskPolicy}), and no `reseed`: the
 * built-in catalog is copied into BOARDS, so an account library starts empty and holds exactly what
 * an account admin authored.
 */
export interface AccountRiskPolicyRepository {
  /** A policy by id, or null if this account defines none under it. */
  get(accountId: string, id: string): Promise<AccountRiskPolicy | null>
  /** Every policy this account defines, oldest first (the tier's editor + the board merge). */
  list(accountId: string): Promise<AccountRiskPolicy[]>
  /**
   * The policies under a SET of ids, in one chunked `IN` query.
   *
   * The batched read exists so resolving a board's library never costs a query per inherited id:
   * the merge reads the whole tier, and the suppression list joins against exactly the ids it
   * holds tombstones for. An empty `ids` is a no-op returning `[]`, never a full-table read.
   */
  listByIds(accountId: string, ids: string[]): Promise<AccountRiskPolicy[]>
  /** Create or replace a policy (keyed by id). */
  upsert(accountId: string, policy: AccountRiskPolicy): Promise<void>
  /** Remove a policy by id (no-op if absent). */
  remove(accountId: string, id: string): Promise<void>
}

/**
 * What a board is HIDING from the account tier: one row per suppressed policy id.
 *
 * A narrow table of its own rather than a tombstone in the policy table, which is the shape the
 * fragment and foundational-service libraries use. Their tombstone earns its place by doing a
 * SECOND job (marking a row removed upstream by a repo sync), and it costs them a rule that a
 * suppression row must never win a merge as an empty override. A risk policy has no upstream sync
 * and ~20 NOT NULL numeric columns, so a tombstone here would mean inventing ceilings for a row
 * that exists only to be absent — and "restore" is then a plain DELETE of a row that asserted one
 * thing, rather than a hard-delete rule protecting against reviving a hollow policy.
 */
export interface RiskPolicySuppressionRepository {
  /** The account policy ids this board hides. */
  list(workspaceId: string): Promise<string[]>
  /** Hide an account policy id. Idempotent: hiding an already-hidden id is a no-op. */
  add(workspaceId: string, policyId: string, at: number): Promise<void>
  /** Stop hiding an id (no-op if it was not hidden). */
  remove(workspaceId: string, policyId: string): Promise<void>
}
