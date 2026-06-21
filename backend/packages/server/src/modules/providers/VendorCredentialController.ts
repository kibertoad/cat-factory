import { addVendorCredentialSchema, type VendorCredential } from '@cat-factory/contracts'
import type { VendorCredentialSummary } from '@cat-factory/integrations'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

// Workspace-scoped vendor-credential (subscription token pool) endpoints. A user
// connects one or more Claude Pro/Max OAuth tokens or ChatGPT auth.json bundles;
// the Claude Code / Codex harnesses lease them with usage-aware rotation. Tokens
// are write-only — only metadata + rolling-window usage is ever returned. Mounted
// under `/workspaces/:workspaceId`.

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    {
      error: {
        code: 'unavailable',
        message: 'Subscription credential storage is not configured',
      },
    },
    503,
  )

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
  }
}

export function vendorCredentialController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.get('/vendor-credentials', async (c) => {
    const subscriptions = c.get('container').subscriptions
    if (!subscriptions) return unavailable(c)
    const tokens = await subscriptions.listTokens(param(c, 'workspaceId'))
    return c.json({ credentials: tokens.map(toWire) })
  })

  app.post('/vendor-credentials', jsonBody(addVendorCredentialSchema), async (c) => {
    const subscriptions = c.get('container').subscriptions
    if (!subscriptions) return unavailable(c)
    const input = c.req.valid('json')
    const summary = await subscriptions.addToken(param(c, 'workspaceId'), input)
    return c.json(toWire(summary), 201)
  })

  app.delete('/vendor-credentials/:id', async (c) => {
    const subscriptions = c.get('container').subscriptions
    if (!subscriptions) return unavailable(c)
    await subscriptions.removeToken(param(c, 'workspaceId'), param(c, 'id'))
    return c.body(null, 204)
  })

  return app
}
