import { effectiveCatalog } from '@cat-factory/kernel'
import { modelCostResolver } from '@cat-factory/spend'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { resolveWorkspaceCapabilities } from '../../agents/providerCapabilities.js'

/**
 * Serves the model picker catalog. Selectability is derived from what is actually
 * configured — a direct API key for the model's provider (the DB pool, scoped to the
 * workspace + its account + the caller), a connected subscription vendor, or the
 * opt-in Cloudflare Workers AI lib being enabled. It exposes only labels and
 * provider/model ids + an `available` flag — never the keys themselves.
 */
export function modelController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Deployment-level catalog (no workspace context): deployment-wide selectability
  // only (no per-workspace direct keys / subscriptions). The picker uses the
  // per-workspace route below; this stays for contexts without a workspace.
  app.get('/models', (c) => {
    c.header('Cache-Control', 'public, max-age=60')
    return c.json(c.get('container').config.models)
  })

  // Per-workspace catalog: selectability reflects this workspace's (+ its account's +
  // the caller's) configured API keys and subscription tokens.
  app.get('/workspaces/:workspaceId/models', async (c) => {
    const container = c.get('container')
    const caps = await resolveWorkspaceCapabilities(
      container,
      param(c, 'workspaceId'),
      c.get('user')?.id,
    )
    const costFor = modelCostResolver(container.config.spend)
    return c.json(effectiveCatalog(caps, costFor))
  })

  return app
}
