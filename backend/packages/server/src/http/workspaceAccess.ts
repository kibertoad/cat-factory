import { resolveWorkspaceAccess, type WorkspaceAccess } from '@cat-factory/kernel'
import type { ServerContainer } from './env.js'

// ---------------------------------------------------------------------------
// The single workspace-RBAC resolution point (workspace-rbac initiative). The auth gate
// (`mountAuthGate`) calls this once per `/workspaces/:ws/*` request; controllers CONSUME
// the resolved `workspaceAccess` off the context, they never re-derive membership.
//
// It performs the three reads `resolveWorkspaceAccess` needs — the board access row, the
// caller's account roles, and their explicit member row — then hands them to the pure
// kernel decision function. Legacy boards (`accountId === null`) are owner-only, so the
// account/member reads are skipped there. The `workspaceAccess` AppCaches slice (a later
// slice) wraps THIS load; today it reads straight through.
// ---------------------------------------------------------------------------

/**
 * Resolve a signed-in user's effective access to one board. Returns `null` when the board
 * doesn't exist (the gate then lets the handler 404 on its own, preserving the pre-RBAC
 * behaviour); otherwise a {@link WorkspaceAccess} decision (`allowed` grant or denial).
 */
export async function loadWorkspaceAccess(
  container: ServerContainer,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceAccess | null> {
  const accessRow = await container.workspaceService.accessRowOf(workspaceId)
  if (!accessRow) return null // missing board → the gate passes through, the handler 404s

  // Legacy / unscoped board: resolution is owner-only, so the account + member reads are
  // pointless — pass empty grants and let rule 1 decide.
  if (accessRow.accountId === null) {
    return resolveWorkspaceAccess({
      userId,
      workspace: accessRow,
      accountRoles: [],
      memberRole: null,
    })
  }

  const [accountRoles, memberRole] = await Promise.all([
    container.accountService.rolesFor(accessRow.accountId, userId),
    container.workspaceService.memberRoleOf(workspaceId, userId),
  ])
  return resolveWorkspaceAccess({ userId, workspace: accessRow, accountRoles, memberRole })
}
