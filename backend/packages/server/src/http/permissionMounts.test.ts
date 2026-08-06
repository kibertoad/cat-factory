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
// no table of paths to keep in step, and one test fails if the app mounts a gate the inventory does
// not, so the derivation cannot quietly cover less than the app serves.
//
// Deriving the expectation is what makes the first test cheap and what bounds it: it compares the
// composed app against each controller's own prefix list, so it catches a gate that REACHES TOO FAR
// (the bug above) and is blind to one that does not reach far enough, since an omitted prefix moves
// both sides of the comparison. Mounting on prefixes traded the wildcard's over-reach for that
// under-reach, so the second test asserts the complement structurally: a gated controller covers
// every route it serves, bar a named member-tier write. Neither test subsumes the other.
// ---------------------------------------------------------------------------

/** One route of one controller, with `:params` filled so it can be requested. */
interface Probe {
  method: string
  path: string
  /** The controller's OWN `METHOD /pattern`, which is how a tier-split exception names a route. */
  route: string
  /** Whether that controller's own permission gate covers this route. */
  gated: boolean
}

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * The writes a GATED controller deliberately leaves at the MEMBER tier, as `METHOD /own-pattern`.
 *
 * Every other write a gated controller serves must be covered by one of that controller's own gate
 * prefixes, and the coverage test below refuses one that is not. This list is the escape hatch, and
 * it is deliberately a list of ROUTES rather than a flag on the controller: a tier split is a claim
 * about which calls are board authoring and which are integration management, so it should read as
 * five named decisions and cost a reviewer's attention to add a sixth.
 *
 * `documentSource` is the only entry, and the rationale for each row is the table in
 * `backend/docs/document-sources.md`: reaching for a page and putting it on a task is authoring,
 * while storing the source credential is not. `defineWorkspaceRbacSuite` asserts the member half
 * end to end (and that a viewer is still refused it by the write floor).
 */
const MEMBER_TIER_WRITES: Readonly<Record<string, readonly string[]>> = {
  documentSource: [
    'POST /document-sources/:source/resolve-ref',
    'POST /document-sources/:source/import',
    'POST /document-sources/:source/search',
    'POST /document-sources/:source/plan',
    'POST /document-sources/:source/spawn',
    'POST /documents/link',
  ],
}

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

/**
 * The gates one controller mounts on itself. A controller's middleware is not necessarily a
 * permission gate (`executionController` and `notificationController` mount their own), so these come
 * from the TAG the mount helper puts on its handler, not from "this entry is middleware".
 */
function gatesOf(app: Hono<AppEnv>): Array<{ pattern: string; gatesReads: boolean }> {
  return app.routes.flatMap((r) => {
    const gate = permissionGateOf(r.handler)
    return gate ? [{ pattern: r.path, gatesReads: gate.gatesReads }] : []
  })
}

/** The distinct routes one controller registers, deduped and in registration order. */
function routesOf(app: Hono<AppEnv>): Array<{ method: string; path: string }> {
  const seen = new Set<string>()
  return app.routes.flatMap((route) => {
    const key = `${route.method} ${route.path}`
    // `buildHonoRoute` registers a validator beside each handler, and a gate is mounted twice.
    if (seen.has(key) || route.method === 'ALL') return []
    seen.add(key)
    return [{ method: route.method, path: route.path }]
  })
}

/** The write routes one controller registers, each tagged with whether that controller gates it. */
function probesFor(app: Hono<AppEnv>, mount: string): Probe[] {
  const gates = gatesOf(app)
  return routesOf(app)
    .filter((route) => WRITE_METHODS.has(route.method))
    .map((route) => ({
      method: route.method,
      path: `${mount}${concrete(route.path)}`,
      route: `${route.method} ${route.path}`,
      gated: gates.some((g) => patternCovers(g.pattern, concrete(route.path))),
    }))
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
    // opposite things. An unexpected 403 is a gate reaching a sibling; a missing one is a gate the
    // controller mounted and the composed app does not apply.
    //
    // What this CANNOT see is a prefix that was never declared: `probe.gated` is derived from the
    // same prefix list, so omitting one flips the expectation and the observation together and this
    // assertion still holds. That is the coverage test below, and the two are not redundant.
    expect(wrong).toEqual([])
  })

  it('a gated controller covers every route it serves, bar a declared member-tier write', () => {
    // The other half of the invariant, and the half the assertion above structurally cannot make.
    // Mounting on prefixes buys scoping at the cost of an enumeration, so a controller that means to
    // gate itself can now under-reach: drop `/tasks` from `taskSourceController` and `POST
    // /tasks/link` plus `POST /tasks/create-block` quietly answer to the member floor instead.
    // Nothing above fails, because the expectation is read off the same list, and
    // `defineWorkspaceRbacSuite` drives ONE representative write per controller (`/task-sources`
    // here), so it misses any SECOND prefix by construction.
    //
    // So: once a controller mounts a gate at all, every route it serves must be covered by one of
    // that controller's own prefixes. Writes always; reads too when the mount is the
    // `IncludingReads` variant, where an uncovered GET is the whole failure it exists to prevent.
    const uncovered: string[] = []
    const stale: string[] = []
    for (const entry of WORKSPACE_CONTROLLERS) {
      const app = entry.build()
      const gates = gatesOf(app)
      // An ungated controller is not under-reaching, it is member-tier: the auth gate's write floor
      // is its enforcement, which is what `boardController` and the human gates rely on.
      if (gates.length === 0) continue
      const gatesReads = gates.some((g) => g.gatesReads)
      const declared = new Set(MEMBER_TIER_WRITES[entry.name] ?? [])
      const claimed = new Set<string>()
      for (const route of routesOf(app)) {
        const name = `${route.method} ${route.path}`
        if (declared.has(name)) claimed.add(name)
        if (gates.some((g) => patternCovers(g.pattern, concrete(route.path)))) continue
        if (!WRITE_METHODS.has(route.method) && !gatesReads) continue
        if (declared.has(name)) continue
        uncovered.push(
          `${entry.name}: ${name} is served by a GATED controller but no prefix covers it`,
        )
      }
      // A stale exception is the same hole wearing the escape hatch: a route that moved or that the
      // controller now gates would leave a row here that silently pre-approves whatever next takes
      // its name. Asserted together with the coverage, since either alone can be satisfied by
      // editing this list rather than the mount.
      for (const name of declared) {
        if (!claimed.has(name))
          stale.push(`${entry.name}: ${name} is declared member-tier but unserved`)
      }
    }
    expect({ uncovered, stale }).toEqual({ uncovered: [], stale: [] })
  })

  it('every gate prefix a controller declares covers a route it actually serves', () => {
    // A prefix that matches nothing is dead config that reads as protection: the spelling `mountGate`
    // cannot refuse (it only rejects an EMPTY list), and the coverage test above sees it as a route
    // being uncovered only while some route still needs it. A renamed path leaves both quiet.
    //
    // Judged per PREFIX, not per emitted pattern: the helper mounts each one bare AND as `/*`, and
    // the `/*` half legitimately matches nothing on a controller with no sub-routes (`/settings`).
    const dead: string[] = []
    for (const entry of WORKSPACE_CONTROLLERS) {
      const app = entry.build()
      const routes = routesOf(app)
      const prefixes = new Set(gatesOf(app).map((g) => g.pattern.replace(/\/\*$/, '')))
      for (const prefix of prefixes) {
        const hit = routes.some(
          (r) =>
            patternCovers(prefix, concrete(r.path)) ||
            patternCovers(`${prefix}/*`, concrete(r.path)),
        )
        if (!hit) dead.push(`${entry.name}: gate prefix ${prefix} matches none of its routes`)
      }
    }
    expect(dead).toEqual([])
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
