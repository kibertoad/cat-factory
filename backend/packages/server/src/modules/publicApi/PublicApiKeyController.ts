import {
  createPublicApiKeyContract,
  listPublicApiKeysContract,
  revokePublicApiKeyContract,
  type PublicApiKey,
} from '@cat-factory/contracts'
import type { PublicApiKeyRecord } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

// Management of INBOUND public-API keys, mounted under `/workspaces/:workspaceId` — so these
// routes are session-authed and pass through the per-workspace authorization gate (only a member
// of the workspace's account reaches them). A workspace owner mints/lists/revokes the keys an
// external system then presents to the `/api/v1` surface (see PublicApiController). The raw key is
// returned exactly once, on create; thereafter only metadata is exposed.

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Public API keys are not configured' } }, 503)

/** Project a stored record onto the secret-free wire type. */
function publicApiKeyToWire(record: PublicApiKeyRecord): PublicApiKey {
  return {
    id: record.id,
    accountId: record.accountId,
    workspaceId: record.workspaceId,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  }
}

/** Public-API-key management routes, mounted under `/workspaces/:workspaceId`. */
export function publicApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listPublicApiKeysContract, async (c) => {
    const publicApiKeys = c.get('container').publicApiKeys
    if (!publicApiKeys) return unavailable(c)
    const keys = await publicApiKeys.list(param(c, 'workspaceId'))
    return c.json({ keys: keys.map(publicApiKeyToWire) }, 200)
  })

  buildHonoRoute(app, createPublicApiKeyContract, async (c) => {
    const container = c.get('container')
    const publicApiKeys = container.publicApiKeys
    if (!publicApiKeys) return unavailable(c)
    const workspaceId = param(c, 'workspaceId')
    // Resolve the owning account; the public API is an account-scoped feature, so refuse to mint a
    // key for a missing workspace (`undefined`) or a legacy account-less board (`null`) rather than
    // persisting an orphan key with an empty `accountId` (the old `?? ''` fallback).
    const accountId = await container.workspaceService.accountOf(workspaceId)
    if (accountId == null) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    }
    const { record, secret } = await publicApiKeys.issue(
      { accountId, workspaceId },
      c.req.valid('json').label,
    )
    return c.json({ key: publicApiKeyToWire(record), secret }, 201)
  })

  buildHonoRoute(app, revokePublicApiKeyContract, async (c) => {
    const publicApiKeys = c.get('container').publicApiKeys
    if (!publicApiKeys) return unavailable(c)
    await publicApiKeys.revoke(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
