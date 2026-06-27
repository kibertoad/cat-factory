import { listModelsContract, listWorkspaceModelsContract } from '@cat-factory/contracts'
import {
  effectiveCatalogWith,
  localSelectableModels,
  openRouterSelectableModels,
} from '@cat-factory/kernel'
import { modelCostResolver, withDynamicPrices } from '@cat-factory/spend'
import { buildHonoRoute } from '@toad-contracts/hono'
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
  buildHonoRoute(app, listModelsContract, (c) => {
    c.header('Cache-Control', 'public, max-age=60')
    return c.json(c.get('container').config.models, 200)
  })

  // Per-workspace catalog: selectability reflects this workspace's (+ its account's +
  // the caller's) configured API keys and subscription tokens.
  buildHonoRoute(app, listWorkspaceModelsContract, async (c) => {
    const container = c.get('container')
    const workspaceId = param(c, 'workspaceId')
    const userId = c.get('user')?.id
    const caps = await resolveWorkspaceCapabilities(container, workspaceId, userId)
    // Surface the caller's own locally-run models (Ollama / LM Studio / …) alongside the
    // built-in catalog. They're scoped to the user (a runner lives on their machine).
    const local =
      userId && container.localModelEndpoints
        ? await container.localModelEndpoints.capabilitiesFor(userId)
        : []
    // Plus this workspace's enabled OpenRouter gateway models (the dynamic catalog), with
    // their live per-model prices overlaid onto the spend table so costs/budgets are exact.
    const openRouter = container.openRouterCatalog
      ? await container.openRouterCatalog.capabilitiesFor(workspaceId)
      : []
    const costFor = modelCostResolver(withDynamicPrices(container.config.spend, openRouter))
    return c.json(
      effectiveCatalogWith(
        [...localSelectableModels(local), ...openRouterSelectableModels(openRouter)],
        caps,
        costFor,
      ),
      200,
    )
  })

  return app
}
