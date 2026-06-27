import {
  getOpenRouterCatalogContract,
  refreshOpenRouterCatalogContract,
  upsertOpenRouterCatalogContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'

// Per-WORKSPACE OpenRouter dynamic catalog. OpenRouter is a single OpenAI-compatible
// gateway to 300+ models reached via the workspace's API-key pool; a workspace browses the
// live catalog (`/refresh`, leasing the pooled OpenRouter key server-side) and enables a
// subset (`PUT /catalog`). The enabled models surface in the per-workspace model picker and
// feed the spend budget. Mounted at `/` (workspaceId is a path param); requires a signed-in user.

const signInRequired = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unauthorized', message: 'Sign in to manage the OpenRouter catalog' } },
    401,
  )

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'OpenRouter catalog storage is not configured' } },
    503,
  )

export function openRouterCatalogController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The workspace's enabled OpenRouter models (empty when none configured yet).
  buildHonoRoute(app, getOpenRouterCatalogContract, async (c) => {
    const svc = c.get('container').openRouterCatalog
    if (!svc) return unavailable(c)
    if (!c.get('user')) return signInRequired(c)
    return c.json(await svc.get(c.req.valid('param').workspaceId), 200)
  })

  // Replace the workspace's enabled subset (the client sends each model's metadata it read
  // from the browse list, so the server + spend table get accurate context + pricing).
  buildHonoRoute(app, upsertOpenRouterCatalogContract, async (c) => {
    const svc = c.get('container').openRouterCatalog
    if (!svc) return unavailable(c)
    if (!c.get('user')) return signInRequired(c)
    return c.json(await svc.upsert(c.req.valid('param').workspaceId, c.req.valid('json')), 200)
  })

  // Probe OpenRouter's live `/models` for the browse list (leases the workspace's pooled
  // OpenRouter key server-side). Never throws — failures come back as { reachable: false }.
  buildHonoRoute(app, refreshOpenRouterCatalogContract, async (c) => {
    const svc = c.get('container').openRouterCatalog
    if (!svc) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json(await svc.refresh(c.req.valid('param').workspaceId, { userId: user.id }), 200)
  })

  return app
}
