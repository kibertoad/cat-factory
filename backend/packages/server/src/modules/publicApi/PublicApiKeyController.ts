import {
  createPublicApiKeyContract,
  listPublicApiKeysContract,
  revokePublicApiKeyContract,
} from '@cat-factory/contracts'
import { ValidationError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import { publicApiKeyToWire } from './keyProjection.js'

// Management of INBOUND public-API keys, mounted under `/workspaces/:workspaceId` — so these
// routes are session-authed and pass through the per-workspace authorization gate (only a member
// of the workspace's account reaches them). A workspace owner mints/lists/revokes the keys an
// external system then presents to the `/api/v1` surface (see PublicApiController). The raw key is
// returned exactly once, on create; thereafter only metadata is exposed.

/** Resolve the public API-key store, or refuse with a 503 naming what isn't wired. */
function requirePublicApiKeys<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').publicApiKeys, 'Public API keys are not configured')
}

/** Public-API-key management routes, mounted under `/workspaces/:workspaceId`. */
export function publicApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'secrets.manage', ['/public-api-keys'])

  buildHonoRoute(app, listPublicApiKeysContract, async (c) => {
    const publicApiKeys = requirePublicApiKeys(c)
    const keys = await publicApiKeys.list(param(c, 'workspaceId'))
    return c.json({ keys: keys.map(publicApiKeyToWire) }, 200)
  })

  buildHonoRoute(app, createPublicApiKeyContract, async (c) => {
    const container = c.get('container')
    const publicApiKeys = requireCapability(
      container.publicApiKeys,
      'Public API keys are not configured',
    )
    const workspaceId = param(c, 'workspaceId')
    // Resolve the owning account; the public API is an account-scoped feature, so refuse to mint a
    // key for a missing workspace (`undefined`) or a legacy account-less board (`null`) rather than
    // persisting an orphan key with an empty `accountId` (the old `?? ''` fallback).
    const accountId = await container.workspaceService.accountOf(workspaceId)
    if (accountId == null) {
      return c.json({ error: { code: 'not_found', message: 'Workspace not found' } }, 404)
    }
    const { label, scope, actsAsSelf } = c.req.valid('json')
    // Attribute the mint to the acting user (audit + UI); `null` in dev-open (no session).
    const createdByUserId = c.get('user')?.id ?? null
    // The binding reads the id off the SESSION and never off the body, which is the whole of the
    // safety argument: the request can only ask for "me", so there is no shape in which one person
    // mints a key onto another's personal subscription. A dev-open mint has no session to read, and
    // a key bound to nobody is exactly an unbound key wearing a promise — so refuse rather than
    // silently drop the flag, since the failure would otherwise surface much later as a run that
    // could not unlock a credential the operator believed they had authorised.
    if (actsAsSelf && !createdByUserId) {
      throw new ValidationError(
        'A key can only be bound to the person minting it, and this request has no signed-in ' +
          'user. Sign in and mint the key again, or mint it unbound.',
        { reason: 'acts_as_self_requires_session' },
      )
    }
    // No `createdByKeyId`: a person minted this one. That field is what marks a key provisioned
    // through `POST /api/v1/keys`, and it is also the link the revocation cascade follows.
    const { record, secret } = await publicApiKeys.issue(
      {
        accountId,
        workspaceId,
        createdByUserId,
        actsAsUserId: actsAsSelf ? createdByUserId : null,
      },
      label,
      scope,
    )
    return c.json({ key: publicApiKeyToWire(record), secret }, 201)
  })

  // Revoking also revokes every key this one minted headlessly (`PublicApiKeyService.revoke`),
  // so an operator killing a compromised credential in the app does not leave its offspring live.
  buildHonoRoute(app, revokePublicApiKeyContract, async (c) => {
    const publicApiKeys = requirePublicApiKeys(c)
    await publicApiKeys.revoke(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.body(null, 204)
  })

  return app
}
