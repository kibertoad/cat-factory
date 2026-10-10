import { listModelsContract, listWorkspaceModelsContract } from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { resolveWorkspaceModelCatalog } from './workspaceCatalog.js'

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
  buildHonoRoute(app, listModelsContract, (c) => {
    c.header('Cache-Control', 'public, max-age=60')
    return c.json(c.get('container').config.models, 200)
  })

  // Per-workspace catalog: selectability reflects this workspace's (+ its account's +
  // the caller's) configured API keys and subscription tokens. The composition lives in
  // `workspaceCatalog.ts` because `GET /api/v1/models` must answer the same question
  // identically; see that file for why a second copy would drift.
  buildHonoRoute(app, listWorkspaceModelsContract, async (c) => {
    const catalog = await resolveWorkspaceModelCatalog(
      c.get('container'),
      param(c, 'workspaceId'),
      c.get('user')?.id,
    )
    return c.json(catalog, 200)
  })

  return app
}
