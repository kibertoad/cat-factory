import { permissionsForRole } from '@cat-factory/kernel'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_CONTROLLERS,
  ACCOUNT_MOUNT,
  registerCoreControllers,
  WORKSPACE_CONTROLLERS,
  WORKSPACE_MOUNT,
} from '../app.js'
import { handleError } from './errorHandler.js'
import { permissionGateOf } from './workspaceAccess.js'
import type { MiddlewareHandler } from 'hono'
import type { SessionPayload } from '../auth/signing.js'
import type { AppEnv, WorkspaceAccessContext } from './env.js'

// ---------------------------------------------------------------------------
// The permission-mount invariant (workspace-rbac): A MEMBER IS REFUSED EXACTLY THE WRITES THEIR OWN
// CONTROLLER GATES, AND NO OTHERS.
//
// Both halves are load-bearing, and the second half is the one that was broken. Every admin
// controller used to gate itself with `app.use('*', requireWorkspacePermission(perm))`, and
// `app.route('/workspaces/:workspaceId', sub)` re-registers a sub-app's `use('*')` as
// `ALL /workspaces/:workspaceId/*` on the SHARED app. Hono runs a matching middleware for every
// route registered after it, so each of those mounts silently gated every SIBLING controller
// registered later in `app.ts`. The admin document and task-source controllers are registered ahead
// of the human-gate controllers, so a plain `member` was refused their own review decisions,
// requirement answers and initiative writes with "requires the integrations.manage permission".
// Nothing failed, because an account admin resolves as a workspace admin, and that is who develops.
//
// This drives the REAL composed app with a real member's resolved access, so it asserts what
// production does rather than restating the mount lines. The expectations are DERIVED twice over:
// `WORKSPACE_CONTROLLERS` is the same list `app.ts` mounts from, and each controller is also built
// standalone so its OWN tagged gate entries say which of its own routes it means to refuse. There is
// no table of paths to keep in step, and the last test fails if the app mounts a gate the inventory
// does not, so the derivation cannot quietly cover less than the app serves.
// ---------------------------------------------------------------------------

/** One route of one controller, with `:params` filled so it can be requested. */
interface Probe {
  method: string
  path: string
  /** Whether that controller's own permission gate covers this route. */
  gated: boolean
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** Fill `:params` with a placeholder segment. Every probe below is refused or fails past the gate. */
function concrete(path: string): string {
  return path.replace(/:[^/]+/g, 'x')
}

/**
 * Does one mounted gate pattern cover a concrete path? Only the two forms `mountWorkspacePermission`
 * emits are understood (`/prefix` and `/prefix/*`, either possibly carrying `:params`), so this
 * cannot silently approve a pattern shape the helper never produces.
 */
function patternCovers(pattern: string, path: string): boolean {
  const subtree = pattern.endsWith('/*')
  const base = concrete(subtree ? pattern.slice(0, -2) : pattern)
  return subtree ? path.startsWith(`${base}/`) : path === base
}

/** The write routes one controller registers, each tagged with whether that controller gates it. */
function probesFor(app: Hono<AppEnv>, mount: string): Probe[] {
  // A controller's middleware is not necessarily a permission gate (`executionController` and
  // `notificationController` mount their own), so the gate patterns come from the TAG the mount
  // helper puts on its handler, not from "this entry is middleware".
  const gates = app.routes
    .filter((r) => permissionGateOf(r.handler) !== undefined)
    .map((r) => r.path)
  const seen = new Set<string>()
  const probes: Probe[] = []
  for (const route of app.routes) {
    if (!WRITE_METHODS.has(route.method)) continue
    const key = `${route.method} ${route.path}`
    if (seen.has(key)) continue // `buildHonoRoute` registers a validator beside each handler
    seen.add(key)
    probes.push({
      method: route.method,
      path: `${mount}${concrete(route.path)}`,
      gated: gates.some((pattern) => patternCovers(pattern, concrete(route.path))),
    })
  }
  return probes
}

/** Every `ALL` entry a set of controllers contributes, as the composed app would record it. */
function gatePathsOf(entries: typeof WORKSPACE_CONTROLLERS): string[] {
  return entries.flatMap((entry) =>
    entry
      .build()
      .routes.filter((r) => r.method === 'ALL')
      .map((r) => `${entry.mount}${r.path}`),
  )
}

describe('workspace permission mounts', () => {
  /** The composed app, answering as a signed-in plain `member` on every workspace. */
  function memberApp(): Hono<AppEnv> {
    const app = new Hono<AppEnv>()
    app.onError(handleError)
    const asMember: MiddlewareHandler<AppEnv> = (c, next) => {
      c.set('user', { sub: 'usr_member', id: 'usr_member' } as unknown as SessionPayload)
      const access: WorkspaceAccessContext = {
        workspaceId: 'x',
        role: 'member',
        permissions: permissionsForRole('member'),
      }
      c.set('workspaceAccess', access)
      return next()
    }
    app.use('*', asMember)
    registerCoreControllers(app)
    return app
  }

  /**
   * Whether the composed app refuses this write for a member. Asserted as 403-ness rather than as a
   * success status because everything past the gate fails on the unwired container or the empty
   * body: what is under test is which of the two answered.
   */
  async function refused(app: Hono<AppEnv>, probe: Probe): Promise<boolean> {
    const res = await app.request(probe.path, {
      method: probe.method,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return res.status === 403
  }

  it('refuses a member exactly the writes their own controller gates', async () => {
    // Workspace scope only. The account tier authorizes on MEMBERSHIP (`accountGuard`) rather than
    // on a workspace permission, which is a different mechanism with its own suite
    // (`foundationalServiceAccountGuard.spec.ts`); the wildcard assertion below still covers it.
    const app = memberApp()
    const wrong: string[] = []
    for (const entry of WORKSPACE_CONTROLLERS) {
      for (const probe of probesFor(entry.build(), entry.mount)) {
        if ((await refused(app, probe)) !== probe.gated) {
          wrong.push(
            `${probe.method} ${probe.path} (${entry.name}): expected ${probe.gated ? '403' : 'not 403'}`,
          )
        }
      }
    }
    // Named rather than counted: a failure has to say WHICH route, because the two directions mean
    // opposite things. An unexpected 403 is a gate reaching a sibling; a missing one is a lost gate.
    expect(wrong).toEqual([])
  })

  it('no controller gates a shared mount prefix wholesale', () => {
    // The bare-wildcard mount, refused structurally: it is the only pattern that can reach a
    // sibling, and the mount helpers cannot emit one. A FACADE mounts `'*'` middleware on the app
    // itself (request logging, the auth gate) and must keep being able to; this asserts only about
    // what `registerCoreControllers` composes.
    const app = new Hono<AppEnv>()
    registerCoreControllers(app)
    const wholesale = app.routes.filter(
      (r) => r.method === 'ALL' && [WORKSPACE_MOUNT, ACCOUNT_MOUNT].includes(r.path.slice(0, -2)),
    )
    expect(wholesale.map((r) => `${r.method} ${r.path}`)).toEqual([])
  })

  it('every gate the composed app mounts comes from a controller the inventory names', () => {
    // What keeps the derivation honest: the first test can only judge controllers listed in
    // `WORKSPACE_CONTROLLERS`, so a gated controller mounted by hand beside the loop would go
    // unexamined. Asserted as a set relation over paths, never as a count, so adding a controller
    // does not re-pin a number.
    const app = new Hono<AppEnv>()
    registerCoreControllers(app)
    const inventory = new Set([
      ...gatePathsOf(WORKSPACE_CONTROLLERS),
      ...gatePathsOf(ACCOUNT_CONTROLLERS),
    ])
    const unaccounted = app.routes
      .filter((r) => r.method === 'ALL')
      .map((r) => r.path)
      .filter((p) => p.startsWith(`${WORKSPACE_MOUNT}/`) || p.startsWith(`${ACCOUNT_MOUNT}/`))
      .filter((p) => !inventory.has(p))
    expect([...new Set(unaccounted)].sort()).toEqual([])
  })
})
