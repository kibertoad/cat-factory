import {
  ALL_SUBSCRIPTION_VENDORS,
  type ProviderCapabilities,
  type SubscriptionVendor,
  effectiveCatalog,
} from '@cat-factory/kernel'
import { modelCostResolver } from '@cat-factory/spend'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

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
    const workspaceId = param(c, 'workspaceId')
    const caps = await buildCapabilities(c, workspaceId)
    const costFor = modelCostResolver(container.config.spend)
    return c.json(effectiveCatalog(caps, costFor))
  })

  return app
}

/** Resolve the provider capabilities for a workspace + the signed-in caller. */
async function buildCapabilities(
  c: Context<AppEnv>,
  workspaceId: string,
): Promise<ProviderCapabilities> {
  const container = c.get('container')
  const userId = c.get('user')?.id
  const directProviders = new Set<string>(
    container.apiKeys ? await container.apiKeys.configuredProviders(workspaceId, { userId }) : [],
  )
  const subscriptionVendors = new Set<SubscriptionVendor>()
  for (const vendor of ALL_SUBSCRIPTION_VENDORS) {
    const pooled = container.subscriptions
      ? await container.subscriptions.hasToken(workspaceId, vendor)
      : false
    const personal =
      !pooled && userId && container.personalSubscriptions
        ? await container.personalSubscriptions.has(userId, vendor)
        : false
    if (pooled || personal) subscriptionVendors.add(vendor)
  }
  return {
    directProviders,
    subscriptionVendors,
    cloudflareEnabled: container.cloudflareModelsEnabled ?? false,
  }
}
