import {
  getOpenRouterCatalogContract,
  refreshOpenRouterCatalogContract,
  upsertOpenRouterCatalogContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability, requireUser } from '../../http/guards.js'

// Per-WORKSPACE OpenRouter dynamic catalog. OpenRouter is a single OpenAI-compatible
// gateway to 300+ models reached via the workspace's API-key pool; a workspace browses the
// live catalog (`/refresh`, leasing the pooled OpenRouter key server-side) and enables a
// subset (`PUT /catalog`). The enabled models surface in the per-workspace model picker and
// feed the spend budget. Mounted at `/` (workspaceId is a path param); requires a signed-in user.

export function openRouterCatalogController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The workspace's enabled OpenRouter models (empty when none configured yet).
  buildHonoRoute(app, getOpenRouterCatalogContract, async (c) => {
    const svc = requireCapability(
      c.get('container').openRouterCatalog,
      'OpenRouter catalog storage is not configured',
    )
    requireUser(c, 'Sign in to manage the OpenRouter catalog')
    return c.json(await svc.get(c.req.valid('param').workspaceId), 200)
  })

  // Replace the workspace's enabled subset (the client sends each model's metadata it read
  // from the browse list, so the server + spend table get accurate context + pricing).
  buildHonoRoute(app, upsertOpenRouterCatalogContract, async (c) => {
    const svc = requireCapability(
      c.get('container').openRouterCatalog,
      'OpenRouter catalog storage is not configured',
    )
    requireUser(c, 'Sign in to manage the OpenRouter catalog')
    return c.json(await svc.upsert(c.req.valid('param').workspaceId, c.req.valid('json')), 200)
  })

  // Probe OpenRouter's live `/models` for the browse list (leases the workspace's pooled
  // OpenRouter key server-side). Never throws — failures come back as { reachable: false }.
  buildHonoRoute(app, refreshOpenRouterCatalogContract, async (c) => {
    const svc = requireCapability(
      c.get('container').openRouterCatalog,
      'OpenRouter catalog storage is not configured',
    )
    const user = requireUser(c, 'Sign in to manage the OpenRouter catalog')
    return c.json(await svc.refresh(c.req.valid('param').workspaceId, { userId: user.id }), 200)
  })

  return app
}
