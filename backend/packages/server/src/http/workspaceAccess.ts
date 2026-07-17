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
// account/member reads are skipped there. The `workspaceAccess` AppCaches slice wraps this
// read-through (group = workspace id, key = user id): a hit costs zero reads, and every write
// that changes the outcome invalidates the entry (the roster/access-mode/delete write paths
// drop the workspace group; the account-tier membership writes drop everything). Pass-through
// on the Worker's isolate-safe profile, so there it reads straight through every time.
// ---------------------------------------------------------------------------

/**
 * Resolve a signed-in user's effective access to one board, THROUGH the `workspaceAccess` cache.
 * Returns `null` when the board doesn't exist (the gate then lets the handler 404 on its own,
 * preserving the pre-RBAC behaviour); otherwise a {@link WorkspaceAccess} decision (`allowed`
 * grant or denial). Both the denial and the missing-board `null` cache as values (negative
 * caching), so a repeat request from the same user on the same board issues no repository reads.
 */
export async function loadWorkspaceAccess(
  container: ServerContainer,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceAccess | null> {
  const { access } = await container.caches.workspaceAccess.get(userId, workspaceId, async () => ({
    access: await resolveWorkspaceAccessUncached(container, workspaceId, userId),
  }))
  return access
}

/** The uncached three-read resolution the cache load wraps (also the pass-through on the Worker). */
async function resolveWorkspaceAccessUncached(
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
