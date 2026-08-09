import {
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  UNATTRIBUTED_BLOCK_EDITOR,
  type BlockEditActor,
  type BlockEditAuthority,
} from '@cat-factory/contracts'
import {
  ForbiddenError,
  resolveWorkspaceAccess,
  type WorkspaceAccess,
  type WorkspacePermission,
} from '@cat-factory/kernel'
import type { Context, Hono, MiddlewareHandler } from 'hono'
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
 * The authority a BOARD EDIT is made under, resolvable in whichever workspace the write actually
 * decides in (ADR 0037).
 *
 * A total accessor for the same reason `runInitiatorRole` is one: a block's `riskPolicyId` decides
 * which roles its runs sandbox and how their auto-merge is narrowed, so re-pointing it is judged
 * against the editor rather than waved through as a preference, and a route that read the facts
 * itself would be a second place to get the dev-open `null` wrong.
 *
 * It resolves PER WORKSPACE rather than handing back the acting board's answer, because a board
 * write does not always decide on the board it was addressed to. A board mounts services homed in
 * other workspaces, and every write on one lands at that home: the row is written there, its
 * preset resolves against that library, and a run on it is admitted through that board under the
 * role the editor holds there. A single pre-resolved actor made the guard read one workspace's
 * policies against another's roles, which refuses and admits by turns for reasons neither
 * workspace states.
 *
 * The acting board costs nothing (the gate already published its resolution); any other workspace
 * goes through the SAME `loadWorkspaceAccess` the gate uses, memoised per request so a subtree
 * spanning two homes reads each once. A workspace the caller cannot see resolves to the
 * unattributed editor: no tier there means no run of theirs is ever admitted under its policies,
 * so none of its restrictions is theirs to drop.
 *
 * With auth disabled the gate resolves no access object, and every workspace returns the
 * unattributed editor rather than an invented tier, the same reading a run started under dev-open
 * gets when it pins no `initiatedByRole`.
 */
export function blockEditAuthority<E extends AppEnv>(c: Context<E>): BlockEditAuthority {
  const acting = c.get('workspaceAccess')
  const user = c.get('user')
  if (!acting || !user) return UNATTRIBUTED_BLOCK_EDIT_AUTHORITY
  const container = c.get('container')
  const userId = user.id
  const resolved = new Map<string, Promise<BlockEditActor>>()
  return {
    in(workspaceId) {
      if (workspaceId === acting.workspaceId) {
        return Promise.resolve({
          role: acting.role,
          managesPolicy: acting.permissions.has('settings.manage'),
        })
      }
      let pending = resolved.get(workspaceId)
      if (!pending) {
        pending = loadWorkspaceAccess(container, workspaceId, userId).then((access) =>
          access?.allowed
            ? { role: access.role, managesPolicy: access.permissions.has('settings.manage') }
            : UNATTRIBUTED_BLOCK_EDITOR,
        )
        resolved.set(workspaceId, pending)
      }
      return pending
    },
  }
}

/**
 * The controller-level admin-tier gate (workspace-rbac, slice 6): every WRITE served under one of
 * `prefixes` requires `permission`, with ZERO per-handler code. Reads (GET/HEAD) pass straight
 * through, so the controller stays viewer-readable (`workspace.read`, satisfied by the gate
 * resolution) while its mutations are admin-only. Use
 * {@link mountWorkspacePermissionIncludingReads} for the rare controller whose READ is the
 * sensitive half.
 *
 * This is the method-shaped counterpart to the gate's viewer floor: the floor rejects viewer writes
 * wholesale (non-GET ⇒ ≥ member) in ONE place; this rejects member writes on the admin groups in
 * ONE place per group. Because it is co-located with the controller's own mount (not a central
 * path→permission table), a new route under a gated prefix inherits the correct gate automatically:
 * the drift a shadow route-map would suffer can't happen. It runs BEFORE the handler, so an
 * unauthorized caller is refused even when the underlying integration is unwired (a member never
 * learns whether Slack/GitHub/etc. is configured), and before body validation, so a malformed
 * payload cannot turn a refusal into a 422 that answers the same question.
 *
 * `OPTIONS` (CORS preflight) is never gated. Where a controller mixes gated and ungated writes
 * under one prefix (e.g. workspace create vs rename), call {@link requirePermission} per-handler
 * instead of mounting this.
 *
 * **`prefixes` are the controller's OWN top-level paths, and taking them is the whole point of this
 * helper.** `app.route('/workspaces/:workspaceId', sub)` re-registers each of `sub`'s entries under
 * that prefix, so a `sub.use('*', …)` becomes `ALL /workspaces/:workspaceId/*` on the shared app and
 * matches routes OTHER controllers mounted on the same prefix. Hono runs a matching middleware for
 * every route registered after it, which made the blast radius depend on the order in `app.ts`: the
 * admin document and task-source controllers are registered ahead of the human-gate controllers, so
 * their `'*'` mounts refused a plain member's review decisions, requirement answers and initiative
 * writes with `integrations.manage`. Nobody noticed because an account admin resolves as a workspace
 * admin, and dogfooding happens as one. Passing prefixes cannot reach a sibling whatever the order,
 * and it is why no middleware factory is exported from this module: a `'*'` mount is now
 * unrepresentable rather than merely discouraged. `permissionMounts.test.ts` pins the invariant
 * (a member is refused exactly the writes their own controller gates).
 *
 * Each prefix is mounted twice, bare and `/*`, because Hono's `*` does not match the bare prefix.
 * A prefix may carry params (`/services/:blockId/test-secrets`), which is how a controller whose
 * routes hang off a shared first segment gates its own without claiming the segment.
 */
export function mountWorkspacePermission<E extends AppEnv>(
  app: Hono<E>,
  permission: WorkspacePermission,
  prefixes: readonly string[],
): void {
  mountGate(app, prefixes, { permission, gatesReads: false }, (c, next) => {
    const method = c.req.method
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      requirePermission(c, permission)
    }
    return next()
  })
}

/**
 * The same controller-level gate, applied to READS as well.
 *
 * {@link mountWorkspacePermission} lets GET/HEAD through by design: on almost every admin
 * controller the permission guards MUTATION and the configuration itself is viewer-readable. A few
 * controllers invert that, because their READ is the sensitive half. The capability-credential
 * checklist and the tool-server inventory both project the credential KEY NAMES this deployment's
 * capabilities want, which is exactly what the workspace snapshot withholds from a viewer ("no
 * business learning which environment variables the deployment sets"). Moving the value into a
 * sealed row did not change that judgement, and neither did adding a second surface over the same
 * registry. `vcsConnectController` is the third and the plainest: it serves ONE read and no write,
 * so the writes-only mount left it enforcing nothing at all.
 *
 * A separate function rather than an option, so the choice is legible at the mount and a controller
 * cannot acquire it by a default changing underneath it. `OPTIONS` still passes: a CORS preflight
 * carries no credentials to judge, and refusing it breaks the browser before the real request that
 * this gate is here to refuse.
 *
 * The failure this exists to prevent is not hypothetical, and all three call sites hit it: each
 * documented the read as gated (in the controller, in the SPA's tab gate, in the store's 403
 * handling) while the mount let every member's GET through, because "gated on `secrets.manage`"
 * reads as covering the controller and covered only its writes. `permissionMounts.test.ts` now
 * asserts the READS of an `IncludingReads` controller are covered too, so the gap cannot reopen
 * by a prefix going missing.
 */
export function mountWorkspacePermissionIncludingReads<E extends AppEnv>(
  app: Hono<E>,
  permission: WorkspacePermission,
  prefixes: readonly string[],
): void {
  mountGate(app, prefixes, { permission, gatesReads: true }, (c, next) => {
    if (c.req.method !== 'OPTIONS') requirePermission(c, permission)
    return next()
  })
}

const MOUNTED_GATE = Symbol('workspacePermissionGate')

/** What one mounted gate enforces: the permission, and whether it covers READS as well. */
export interface MountedGate {
  permission: WorkspacePermission
  /** True for {@link mountWorkspacePermissionIncludingReads}, false for the writes-only mount. */
  gatesReads: boolean
}

/** A middleware viewed through the tag {@link mountGate} stamps on it — present only on one
 *  this module mounted, so the property is optional and its value untyped. */
type GateTaggedHandler = { readonly [MOUNTED_GATE]?: unknown }

/**
 * Whether a read-back tag really is a mount record.
 *
 * A guard rather than an assertion: `permissionGateOf` is handed an arbitrary handler off a
 * composed Hono app, so "some non-null object lives under our symbol" is not the same fact as
 * "this handler is one of our gates". Asserting instead would let an unrelated tagged object
 * through as a gate carrying `undefined` for both fields, which is precisely the reading
 * `permissionMounts.test.ts` derives its invariant from.
 */
function isMountedGate(value: unknown): value is MountedGate {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<MountedGate>
  return typeof candidate.permission === 'string' && typeof candidate.gatesReads === 'boolean'
}

/**
 * What a mounted gate enforces, or `undefined` for any other middleware.
 *
 * Read off a controller's route table by `permissionMounts.test.ts`, which asserts that a member is
 * refused exactly the writes their own controller gates AND that a gated controller leaves none of
 * its own routes uncovered. It exists because a controller's middleware is not necessarily a
 * permission gate: `executionController` and `notificationController` both mount their own `ALL`
 * middleware, and treating every middleware entry as a gate made the derived expectation wrong for
 * them. Tagging the handler is what lets the invariant be READ from what the mount actually did
 * instead of from a second list somebody has to keep in step.
 *
 * Read it off a STANDALONE-built controller, not the composed app: `app.route()` passes a sub-app's
 * handlers through untouched only while the sub-app has no error handler of its own, and wraps them
 * (losing this tag) the moment one calls `app.onError`. No controller does today, and the invariant
 * does not depend on none ever doing.
 */
export function permissionGateOf(handler: unknown): MountedGate | undefined {
  if (typeof handler !== 'function') return undefined
  const tag = (handler as GateTaggedHandler)[MOUNTED_GATE]
  return isMountedGate(tag) ? tag : undefined
}

/** Mount one gate on each prefix, bare and `/*` (Hono's `*` does not match the bare prefix). */
function mountGate<E extends AppEnv>(
  app: Hono<E>,
  prefixes: readonly string[],
  mounted: MountedGate,
  gate: MiddlewareHandler<E>,
): void {
  if (prefixes.length === 0) {
    // A gated controller with no prefix would gate nothing while reading as gated, which is the
    // silent hole this whole helper exists to close. A prefix that matches none of the controller's
    // routes is the same hole one step later, so `permissionMounts.test.ts` refuses that too: this
    // throw can only catch the spelling of it that names no path at all.
    throw new Error('mountWorkspacePermission: at least one path prefix is required')
  }
  Object.defineProperty(gate, MOUNTED_GATE, { value: mounted })
  for (const prefix of prefixes) {
    app.use(prefix, gate)
    app.use(`${prefix}/*`, gate)
  }
}
