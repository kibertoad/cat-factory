import {
  addVendorCredentialContract,
  listVendorCredentialsContract,
  removeVendorCredentialContract,
  updateVendorCredentialContract,
  type VendorCredential,
} from '@cat-factory/contracts'
import type { VendorCredentialSummary } from '@cat-factory/integrations'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

// Workspace-scoped vendor-credential (subscription token pool) endpoints. A user
// connects one or more Claude Pro/Max OAuth tokens or ChatGPT auth.json bundles;
// the Claude Code / Codex harnesses lease them with usage-aware rotation. Tokens
// are write-only — only metadata + rolling-window usage is ever returned. Mounted
// under `/workspaces/:workspaceId`.

/** Project the service summary onto the wire type (already secret-free). */
function toWire(summary: VendorCredentialSummary): VendorCredential {
  return {
    id: summary.id,
    vendor: summary.vendor,
    label: summary.label,
    createdAt: summary.createdAt,
    lastUsedAt: summary.lastUsedAt,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    requestCount: summary.requestCount,
    enabled: summary.enabled,
    isDefault: summary.isDefault,
  }
}

/** Resolve the subscription-credential store, or refuse with a 503 naming what isn't wired. */
function requireSubscriptions<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').subscriptions,
    'Subscription credential storage is not configured',
  )
}

export function vendorCredentialController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'secrets.manage', ['/vendor-credentials'])

  buildHonoRoute(app, listVendorCredentialsContract, async (c) => {
    const subscriptions = requireSubscriptions(c)
    const tokens = await subscriptions.listTokens(param(c, 'workspaceId'))
    return c.json({ credentials: tokens.map(toWire) }, 200)
  })

  buildHonoRoute(app, addVendorCredentialContract, async (c) => {
    const subscriptions = requireSubscriptions(c)
    const input = c.req.valid('json')
    const summary = await subscriptions.addToken(param(c, 'workspaceId'), input)
    return c.json(toWire(summary), 201)
  })

  buildHonoRoute(app, updateVendorCredentialContract, async (c) => {
    const subscriptions = requireSubscriptions(c)
    const summary = await subscriptions.updateToken(
      param(c, 'workspaceId'),
      c.req.valid('param').id,
      c.req.valid('json'),
    )
    return c.json(toWire(summary), 200)
  })

  buildHonoRoute(app, removeVendorCredentialContract, async (c) => {
    const subscriptions = requireSubscriptions(c)
    await subscriptions.removeToken(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
