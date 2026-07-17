import {
  listEnvironmentUserHandlersContract,
  provisionTypeSchema,
  removeEnvironmentUserHandlerContract,
  upsertEnvironmentUserHandlerContract,
} from '@cat-factory/contracts'
import { ForbiddenError, NotFoundError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { loadWorkspaceAccess } from '../../http/workspaceAccess.js'

// Per-USER infra handler overrides (local mode). A developer points a provision type at
// their OWN engine (a personal Docker / k3s), and that override wins for the runs they
// initiate. Mounted at the root (no `/workspaces` prefix) and scoped to the signed-in user,
// like local model runners + personal subscriptions. The override SERVICE is wired ONLY by
// the local facade (it wires `environmentUserHandlerRepository`), so these endpoints 503 on
// the Worker/Node facades — the local-only behaviour is enforced by container wiring, not a
// runtime branch here. See docs/initiatives/per-service-provision-types.md.

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unauthorized', message: 'Sign in to manage environment handler overrides' } },
    401,
  )

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Per-user environment handlers are not configured' } },
    503,
  )

/**
 * Workspace-RBAC (workspace-rbac initiative, slice 7). These routes are mounted at `/`, OUTSIDE
 * the `/workspaces/:ws/*` gate, so they resolve access themselves through the SAME shared
 * `loadWorkspaceAccess` the gate uses, then require `runs.execute` — a per-user infra override
 * steers the runs the caller initiates, so it belongs to the run-execution surface. A caller with
 * no access at all gets a 404 (existence is hidden exactly as the gate hides a board, via the same
 * `NotFoundError` the `requireMember`-style guards use); a caller who SEES the board but lacks the
 * capability gets a 403 (insufficiency, not existence). Throws on denial/insufficiency — the
 * handler proceeds only when the caller is authorised.
 */
async function requireRunsExecute<E extends AppEnv>(
  c: Context<E>,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const access = await loadWorkspaceAccess(c.get('container'), workspaceId, userId)
  if (!access || !access.allowed) {
    // Missing OR denied → 404, never leaking whether the board exists.
    throw new NotFoundError('Workspace', workspaceId)
  }
  if (!access.permissions.has('runs.execute')) {
    throw new ForbiddenError('This action requires the runs.execute permission', {
      permission: 'runs.execute',
    })
  }
}

export function environmentUserHandlerController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Authorization runs BEFORE the service-availability (503) check on purpose: a caller who
  // cannot see the board must get the same 404 whether or not this (local-only) feature is
  // wired, so an unwired facade never reveals a board's existence to a non-member.

  buildHonoRoute(app, listEnvironmentUserHandlersContract, async (c) => {
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const workspaceId = c.req.valid('param').workspaceId
    await requireRunsExecute(c, workspaceId, user.id)
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    const handlers = await svc.list(user.id, workspaceId)
    return c.json({ handlers }, 200)
  })

  buildHonoRoute(app, upsertEnvironmentUserHandlerContract, async (c) => {
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const { workspaceId, provisionType: rawType } = c.req.valid('param')
    await requireRunsExecute(c, workspaceId, user.id)
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    // The provision type comes from the path; the body's value is overridden by it.
    const provisionType = v.parse(provisionTypeSchema, rawType)
    const view = await svc.upsert(user.id, workspaceId, {
      ...c.req.valid('json'),
      provisionType,
    })
    return c.json(view, 201)
  })

  buildHonoRoute(app, removeEnvironmentUserHandlerContract, async (c) => {
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const { workspaceId, provisionType: rawType } = c.req.valid('param')
    await requireRunsExecute(c, workspaceId, user.id)
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    const provisionType = v.parse(provisionTypeSchema, rawType)
    const manifestId = c.req.valid('query').manifestId ?? null
    await svc.remove(user.id, workspaceId, provisionType, manifestId)
    return c.body(null, 204)
  })

  return app
}
