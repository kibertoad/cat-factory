import type { WorkspaceRole } from '../domain/types.js'

// ---------------------------------------------------------------------------
// Persistence port for the workspace-membership tier (workspace RBAC). A row scopes
// a user to a board with a workspace role; an unrestricted (`access_mode='account'`)
// board still honours a row as an upgrade-only overlay, a restricted board reads it
// as the sole grant. The facades implement this against D1 / Drizzle; the domain
// never imports a concrete adapter.
//
// Batch-shaped by construction — never a per-member point-read loop (the banned N+1
// class). `getRolesForUserInWorkspaces` annotates a workspace LIST with one chunked-IN
// read; `removeByAccountMembership` is the one-statement hygiene cascade for when an
// account membership is revoked.
// ---------------------------------------------------------------------------

export interface WorkspaceMemberRecord {
  workspaceId: string
  userId: string
  role: WorkspaceRole
  createdAt: number
  /** Audit: who granted the membership; null for system grants (creator auto-enroll). */
  addedByUserId: string | null
}

export interface WorkspaceMemberRepository {
  get(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord | null>
  /** The full roster of a board (its member rows), for the members API + management UI. */
  listByWorkspace(workspaceId: string): Promise<WorkspaceMemberRecord[]>
  /** Every workspace id a user has an explicit member row in (drives visibility). */
  listWorkspaceIdsForUser(userId: string): Promise<string[]>
  /**
   * The caller's role in each of `workspaceIds`, in ONE chunked-IN read — used to
   * annotate a workspace LIST with the viewer's effective member role without a
   * per-board round-trip. Keyed by workspace id; boards with no row for the user are
   * simply absent. Returns a plain `Record` (NOT a `Map`) so the value round-trips over
   * the mothership persistence RPC — this read is on the `GET /workspaces` edge path, so
   * it must be JSON-serializable (a `Map` serializes to `{}`); `WorkspaceService` rebuilds
   * a `Map` for its in-process callers.
   */
  getRolesForUserInWorkspaces(
    userId: string,
    workspaceIds: string[],
  ): Promise<Record<string, WorkspaceRole>>
  upsert(member: WorkspaceMemberRecord): Promise<void>
  remove(workspaceId: string, userId: string): Promise<void>
  /**
   * Hygiene cascade when an account membership is removed: drop every workspace_members
   * row this user holds in boards owned by `accountId`, in ONE statement joined on
   * `workspaces.account_id` (an orphaned row is already fail-closed by resolution, but
   * this keeps the roster honest). Returns the number of rows removed.
   */
  removeByAccountMembership(accountId: string, userId: string): Promise<number>
}
