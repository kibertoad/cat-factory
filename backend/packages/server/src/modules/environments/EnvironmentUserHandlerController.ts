import {
  listEnvironmentUserHandlersContract,
  provisionTypeSchema,
  removeEnvironmentUserHandlerContract,
  upsertEnvironmentUserHandlerContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

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

export function environmentUserHandlerController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listEnvironmentUserHandlersContract, async (c) => {
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const handlers = await svc.list(user.id, c.req.valid('param').workspaceId)
    return c.json({ handlers }, 200)
  })

  buildHonoRoute(app, upsertEnvironmentUserHandlerContract, async (c) => {
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const { workspaceId, provisionType: rawType } = c.req.valid('param')
    // The provision type comes from the path; the body's value is overridden by it.
    const provisionType = v.parse(provisionTypeSchema, rawType)
    const view = await svc.upsert(user.id, workspaceId, {
      ...c.req.valid('json'),
      provisionType,
    })
    return c.json(view, 201)
  })

  buildHonoRoute(app, removeEnvironmentUserHandlerContract, async (c) => {
    const svc = c.get('container').environments?.userHandlerService
    if (!svc) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    const { workspaceId, provisionType: rawType } = c.req.valid('param')
    const provisionType = v.parse(provisionTypeSchema, rawType)
    const manifestId = c.req.valid('query').manifestId ?? null
    await svc.remove(user.id, workspaceId, provisionType, manifestId)
    return c.body(null, 204)
  })

  return app
}
