import { upsertOpenRouterCatalogSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

// Per-WORKSPACE OpenRouter dynamic catalog. OpenRouter is a single OpenAI-compatible
// gateway to 300+ models reached via the workspace's API-key pool; a workspace browses the
// live catalog (`/refresh`, leasing the pooled OpenRouter key server-side) and enables a
// subset (`PUT /catalog`). The enabled models surface in the per-workspace model picker and
// feed the spend budget. Mounted under a workspace; requires a signed-in user.

const signInRequired = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unauthorized', message: 'Sign in to manage the OpenRouter catalog' } },
    401,
  )

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'OpenRouter catalog storage is not configured' } },
    503,
  )

export function openRouterCatalogController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The workspace's enabled OpenRouter models (empty when none configured yet).
  app.get('/workspaces/:workspaceId/openrouter/catalog', async (c) => {
    const svc = c.get('container').openRouterCatalog
    if (!svc) return unavailable(c)
    if (!c.get('user')) return signInRequired(c)
    return c.json(await svc.get(param(c, 'workspaceId')))
  })

  // Replace the workspace's enabled subset (the client sends each model's metadata it read
  // from the browse list, so the server + spend table get accurate context + pricing).
  app.put(
    '/workspaces/:workspaceId/openrouter/catalog',
    jsonBody(upsertOpenRouterCatalogSchema),
    async (c) => {
      const svc = c.get('container').openRouterCatalog
      if (!svc) return unavailable(c)
      if (!c.get('user')) return signInRequired(c)
      return c.json(await svc.upsert(param(c, 'workspaceId'), c.req.valid('json')))
    },
  )

  // Probe OpenRouter's live `/models` for the browse list (leases the workspace's pooled
  // OpenRouter key server-side). Never throws — failures come back as { reachable: false }.
  app.post('/workspaces/:workspaceId/openrouter/refresh', async (c) => {
    const svc = c.get('container').openRouterCatalog
    if (!svc) return unavailable(c)
    const user = c.get('user')
    if (!user) return signInRequired(c)
    return c.json(await svc.refresh(param(c, 'workspaceId'), { userId: user.id }))
  })

  return app
}
