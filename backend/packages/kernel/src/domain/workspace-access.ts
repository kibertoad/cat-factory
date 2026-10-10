// ---------------------------------------------------------------------------
// Workspace-level RBAC: the permission catalog + effective-role resolution. This
// is SERVER POLICY (below the HTTP layer so the workspaces-package services and the
// conformance suite can reach it), NOT wire shape — the unions live in
// `@cat-factory/contracts` and are re-exported by `./types`.
//
// The three fixed roles form a strict lattice `viewer < member < admin`; each maps
// onto a set of {@link WorkspacePermission}s via the static table below. Enforcement
// resolves the caller's EFFECTIVE role once (the gate), then checks a permission set
// — never scattered role comparisons.
// ---------------------------------------------------------------------------

import type {
  AccountRole,
  WorkspaceAccessMode,
  WorkspacePermission,
  WorkspaceRole,
} from './types.js'

/** The full permission set an `admin` holds (also the catalog's canonical order). */
const ALL_WORKSPACE_PERMISSIONS: readonly WorkspacePermission[] = [
  'workspace.read',
  'board.write',
  'runs.execute',
  'settings.manage',
  'integrations.manage',
  'secrets.manage',
  'members.manage',
]

/**
 * The static role → permission map. `viewer` reads only; `member` adds board
 * mutation + run execution (the developer surface); `admin` holds everything.
 * `board.write` and `runs.execute` are carried separately even though both land on
 * `member`, so a post-1.0 custom-role model (and machine principals) can split them
 * without re-cataloguing — the cost of the split now is one array entry.
 */
export const WORKSPACE_ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  viewer: ['workspace.read'],
  member: ['workspace.read', 'board.write', 'runs.execute'],
  admin: ALL_WORKSPACE_PERMISSIONS,
}

/** Rank in the `viewer < member < admin` lattice; higher wins when grants combine. */
const ROLE_RANK: Record<WorkspaceRole, number> = { viewer: 0, member: 1, admin: 2 }

/** True when `role` is at least `floor` in the lattice (`admin >= member`, etc.). */
export function workspaceRoleAtLeast(role: WorkspaceRole, floor: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[floor]
}

/** The higher of two roles in the lattice (the effective role when grants combine). */
function maxRole(a: WorkspaceRole, b: WorkspaceRole): WorkspaceRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b
}

/** The permission set a role resolves to, as a `Set` for O(1) `requirePermission` checks. */
export function permissionsForRole(role: WorkspaceRole): ReadonlySet<WorkspacePermission> {
  return new Set(WORKSPACE_ROLE_PERMISSIONS[role])
}

/** The narrow access row the gate reads to resolve a board's membership tier. */
export interface WorkspaceAccessRow {
  /** The owning account, or `null` for a legacy/unscoped board. */
  accountId: string | null
  /** The owning user for a legacy board (`account_id IS NULL`), else `null`. */
  ownerUserId: string | null
  accessMode: WorkspaceAccessMode
}

export interface ResolveWorkspaceAccessInput {
  userId: string
  workspace: WorkspaceAccessRow
  /** The caller's account roles in the board's owning account; `[]` when not a member. */
  accountRoles: AccountRole[]
  /** The caller's `workspace_members` row role, if any. */
  memberRole: WorkspaceRole | null
}

/**
 * The resolved access decision. A denial is presented as a 404 by the gate (never
 * leak existence); a grant carries the effective role + its permission set.
 */
export type WorkspaceAccess =
  | { allowed: true; role: WorkspaceRole; permissions: ReadonlySet<WorkspacePermission> }
  | { allowed: false }

const DENIED: WorkspaceAccess = { allowed: false }

function grant(role: WorkspaceRole): WorkspaceAccess {
  return { allowed: true, role, permissions: permissionsForRole(role) }
}

/**
 * Resolve a user's effective role on one board. The single decision point the gate
 * calls; controllers consume the result, never re-derive it.
 *
 * Precedence (effective role = max of applicable grants):
 *  1. Legacy board (`accountId === null`): the owner is `admin`, everyone else denied.
 *  2. Not an account member (`accountRoles` empty) ⇒ denied — account membership is a
 *     PREREQUISITE, so an orphaned `workspace_members` row is inert / fail-closed.
 *  3. Account `admin` ⇒ workspace `admin` (the escape hatch; no lock-out is possible).
 *  4. `accessMode: 'account'`: a non-admin account member is `member`; a member ROW is
 *     an UPGRADE-ONLY overlay (max) — a `viewer` row never demotes in account mode.
 *  5. `accessMode: 'restricted'`: the member row's role; no row (and not account admin)
 *     ⇒ denied.
 */
export function resolveWorkspaceAccess(input: ResolveWorkspaceAccessInput): WorkspaceAccess {
  const { userId, workspace, accountRoles, memberRole } = input

  // 1. Legacy / unscoped board: owner-only, byte-for-byte the pre-RBAC gate.
  if (workspace.accountId === null) {
    return workspace.ownerUserId !== null && workspace.ownerUserId === userId
      ? grant('admin')
      : DENIED
  }

  // 2. Account membership is a prerequisite for any workspace-tier grant.
  if (accountRoles.length === 0) return DENIED

  // 3. Account admin is always a workspace admin (the escape hatch).
  if (accountRoles.includes('admin')) return grant('admin')

  // 4. Account mode: account members are `member`; a member row can only upgrade.
  if (workspace.accessMode === 'account') {
    return grant(memberRole ? maxRole('member', memberRole) : 'member')
  }

  // 5. Restricted mode: the member row is the sole grant.
  return memberRole ? grant(memberRole) : DENIED
}
