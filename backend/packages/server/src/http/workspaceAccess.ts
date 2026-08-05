import { UNATTRIBUTED_BLOCK_EDITOR, type BlockEditActor } from '@cat-factory/contracts'
import {
  ForbiddenError,
  resolveWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspacePermission,
} from '@cat-factory/kernel'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppEnv, ServerContainer } from './env.js'

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

/**
 * The admin-tier enforcement helper (workspace-rbac). The gate already ran the resolution + the
 * method-shaped viewer write floor (any non-GET ⇒ ≥ member) before a controller executes; this
 * adds the PERMISSION-shaped check for the admin route groups (`settings.manage` /
 * `integrations.manage` / `secrets.manage` / `members.manage`). It CONSUMES the access the gate
 * published — it never re-derives membership.
 *
 * Dev-open parity: with auth disabled there is no signed-in user AND no resolved access object, so
 * the check allows everything (mirroring the gate's `if (!user) return next()` and the SPA's
 * absent-access ⇒ allow-all). A signed-in user always has a resolved access object here (the gate
 * set it, or already 404'd), so a missing object for a signed-in caller fails closed.
 *
 * Throws {@link ForbiddenError} (→ 403) on insufficiency — the caller already SEES the board, so
 * only capability, not existence, is revealed (never the 404 the gate uses to hide a board).
 */
export function requirePermission<E extends AppEnv>(
  c: Context<E>,
  permission: WorkspacePermission,
): void {
  const access = c.get('workspaceAccess')
  if (!access) {
    if (!c.get('user')) return // dev-open: no user, no access object ⇒ allow all
    throw new ForbiddenError(`This action requires the ${permission} permission`, { permission })
  }
  if (!access.permissions.has(permission)) {
    throw new ForbiddenError(`This action requires the ${permission} permission`, { permission })
  }
}

/**
 * The authority a BOARD EDIT is made under, as the auth gate already resolved it (ADR 0037).
 *
 * A total accessor for the same reason `runInitiatorRole` is one: a task's `riskPolicyId` decides
 * which roles its runs sandbox and how their auto-merge is narrowed, so re-pointing it is judged
 * against the editor rather than waved through as a preference, and a route that read the two
 * facts itself would be a second place to get the dev-open `null` wrong.
 *
 * With auth disabled the gate resolves no access object, and this returns the unattributed editor
 * rather than inventing one: there is no tier whose restrictions could be dropped, which is the
 * same reading a run started under dev-open gets when it pins no `initiatedByRole`.
 */
export function blockEditActor<E extends AppEnv>(c: Context<E>): BlockEditActor {
  const access = c.get('workspaceAccess')
  if (!access) return UNATTRIBUTED_BLOCK_EDITOR
  return { role: access.role, managesPolicy: access.permissions.has('settings.manage') }
}

/**
 * Controller-level admin-tier gate (workspace-rbac, slice 6). Mount ONCE at the top of an
 * admin route group — `app.use('*', requireWorkspacePermission('integrations.manage'))` —
 * and every WRITE the controller serves (now and in the future) requires that permission,
 * with ZERO per-handler code. Reads (GET/HEAD) pass straight through, so the whole controller
 * stays viewer-readable (`workspace.read`, satisfied by the gate resolution) while its mutations
 * are admin-only.
 *
 * This is the method-shaped counterpart to the gate's viewer floor: the floor rejects viewer
 * writes wholesale (non-GET ⇒ ≥ member) in ONE place; this rejects member writes on the admin
 * groups in ONE place per group. Because it is co-located with the controller's mount (not a
 * central path→permission table), a new route inherits the correct gate automatically — the
 * drift a shadow route-map would suffer can't happen. It runs BEFORE the handler, so an
 * unauthorized caller is refused even when the underlying integration is unwired (a member never
 * learns whether Slack/GitHub/etc. is configured).
 *
 * `OPTIONS` (CORS preflight) is never gated. Where a controller mixes gated and ungated writes
 * under one mount (e.g. workspace create vs rename), call {@link requirePermission} per-handler
 * instead of mounting this.
 *
 * ⚠️ **A `'*'` mount is NOT scoped to the controller.** `app.route('/workspaces/:workspaceId', sub)`
 * re-registers each of `sub`'s entries under that prefix, and a `sub.use('*', …)` becomes
 * `ALL /workspaces/:workspaceId/*` on the shared app — so it also matches routes OTHER controllers
 * mounted on the same prefix. Hono then runs whichever matching entry was registered first, which
 * makes the blast radius depend on the order in `app.ts`: today the run controllers are registered
 * before the config ones, so their routes win and the existing `'*'` mounts reach only the config
 * controllers listed after them (all admin-tier, which is why nothing has surfaced). Prefer mounting
 * on the controller's OWN path patterns (`/thing` and `/thing/*`), which cannot reach a sibling
 * whatever the order — as {@link requireWorkspacePermissionIncludingReads}'s two call sites do,
 * because for them the ordering accident stopped being harmless.
 */
export function requireWorkspacePermission<E extends AppEnv>(
  permission: WorkspacePermission,
): MiddlewareHandler<E> {
  return (c, next) => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      requirePermission(c, permission)
    }
    return next()
  }
}

/**
 * The same controller-level gate, applied to READS as well.
 *
 * {@link requireWorkspacePermission} lets GET/HEAD through by design: on almost every admin
 * controller the permission guards MUTATION and the configuration itself is viewer-readable. A few
 * controllers invert that, because their READ is the sensitive half — the capability-credential
 * checklist and the tool-server inventory both project the credential KEY NAMES this deployment's
 * capabilities want, which is exactly what the workspace snapshot withholds from a viewer ("no
 * business learning which environment variables the deployment sets"). Moving the value into a
 * sealed row did not change that judgement, and neither did adding a second surface over the same
 * registry.
 *
 * A separate function rather than an option, so the choice is legible at the mount and a controller
 * cannot acquire it by a default changing underneath it. `OPTIONS` still passes: a CORS preflight
 * carries no credentials to judge, and refusing it breaks the browser before the real request that
 * this gate is here to refuse.
 *
 * The failure this exists to prevent is not hypothetical. Both call sites documented the read as
 * gated (in the controller, in the SPA's tab gate, in the store's 403 handling) while the mount let
 * every member's GET through, because "gated on `secrets.manage`" reads as covering the controller
 * and covered only its writes.
 *
 * ⚠️ **Mount this on the controller's OWN path patterns, never `'*'`.** See the warning on
 * {@link requireWorkspacePermission}: a `'*'` mount lands on `/workspaces/:workspaceId/*` and can
 * refuse a SIBLING controller's routes. That is survivable while only writes are gated (the
 * siblings it can reach are admin-tier anyway); gating READS makes it fatal, because the same
 * pattern then refuses every member-readable GET registered after it — `GET /github/repos` was the
 * one that caught it. Two patterns are needed, `/thing` and `/thing/*`: Hono's `*` does not match
 * the bare prefix.
 */
export function requireWorkspacePermissionIncludingReads<E extends AppEnv>(
  permission: WorkspacePermission,
): MiddlewareHandler<E> {
  return (c, next) => {
    if (c.req.method !== 'OPTIONS') requirePermission(c, permission)
    return next()
  }
}
