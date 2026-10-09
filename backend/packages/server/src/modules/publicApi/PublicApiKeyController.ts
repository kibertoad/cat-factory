import type { PublicApiKeyRecord } from '@cat-factory/kernel'
import {
  createPublicApiKeyContract,
  listPublicApiKeysContract,
  revokePublicApiKeyContract,
} from '@cat-factory/contracts'
import { keyReaches } from '@cat-factory/integrations'
import { ForbiddenError, NotFoundError, ValidationError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability, requireUser } from '../../http/guards.js'
import { assertWorkspacesInAccount, publicApiKeyToWire } from './keyProjection.js'

// Management of INBOUND public-API keys, mounted under `/workspaces/:workspaceId` — so these
// routes are session-authed and pass through the per-workspace authorization gate (only a member
// of the workspace's account reaches them). A workspace owner mints/lists/revokes the keys an
// external system then presents to the `/api/v1` surface (see PublicApiController). The raw key is
// returned exactly once, on create; thereafter only metadata is exposed.

/** Whether a reach is exactly this one board. */
function isOnly(reach: string[] | null, workspaceId: string): boolean {
  return reach !== null && reach.length === 1 && reach[0] === workspaceId
}

async function requireAccountOf<E extends AppEnv>(c: Context<E>, workspaceId: string) {
  const accountId = await c.get('container').workspaceService.accountOf(workspaceId)
  if (accountId == null) throw new NotFoundError('Workspace', workspaceId)
  return accountId
}

/** A key reaching past this board is an account-level credential, so only an account admin manages it. */
async function requireAccountAdmin<E extends AppEnv>(c: Context<E>, accountId: string) {
  const user = requireUser(c, 'Managing a multi-workspace key requires a signed-in user')
  const membership = await c.get('container').accountService.requireMember(accountId, user.id)
  if (!membership.roles.includes('admin')) {
    throw new ForbiddenError(
      'Only an account admin can manage a key that reaches other workspaces',
      {
        reason: 'account_admin_required',
      },
    )
  }
}

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
    const workspaceId = param(c, 'workspaceId')
    const accountId = await requireAccountOf(c, workspaceId)
    const keys = await publicApiKeys.listReaching(accountId, workspaceId)
    return c.json(
      { keys: keys.map((key: PublicApiKeyRecord) => publicApiKeyToWire(key, workspaceId)) },
      200,
    )
  })

  buildHonoRoute(app, createPublicApiKeyContract, async (c) => {
    const container = c.get('container')
    const publicApiKeys = requirePublicApiKeys(c)
    const workspaceId = param(c, 'workspaceId')
    const accountId = await requireAccountOf(c, workspaceId)
    const { label, scope, actsAsSelf, workspaceIds } = c.req.valid('json')
    const createdByUserId = c.get('user')?.id ?? null
    if (actsAsSelf && !createdByUserId) {
      throw new ValidationError(
        'A key can only be bound to the person minting it, and this request has no signed-in ' +
          'user. Sign in and mint the key again, or mint it unbound.',
        { reason: 'acts_as_self_requires_session' },
      )
    }
    // Omitted means this board alone, which `secrets.manage` on it is enough for. Any other reach
    // spans boards this permission says nothing about, so it takes an account admin.
    const reach = workspaceIds === undefined ? [workspaceId] : workspaceIds
    if (!isOnly(reach, workspaceId)) await requireAccountAdmin(c, accountId)
    await assertWorkspacesInAccount(container.workspaceService, accountId, reach)
    const { record, secret } = await publicApiKeys.issue(
      {
        accountId,
        workspaceIds: reach,
        createdByUserId,
        actsAsUserId: actsAsSelf ? createdByUserId : null,
      },
      label,
      scope,
    )
    return c.json({ key: publicApiKeyToWire(record, workspaceId), secret }, 201)
  })

  buildHonoRoute(app, revokePublicApiKeyContract, async (c) => {
    const publicApiKeys = requirePublicApiKeys(c)
    const workspaceId = param(c, 'workspaceId')
    const accountId = await requireAccountOf(c, workspaceId)
    const target = await publicApiKeys.getLive(accountId, c.req.valid('param').id)
    // A key this board cannot reach is not this panel's to revoke; unknown and revoked keys are
    // the same idempotent 204 they always were.
    if (target && keyReaches(target.workspaceIds, workspaceId)) {
      if (!isOnly(target.workspaceIds, workspaceId)) await requireAccountAdmin(c, accountId)
      await publicApiKeys.revoke(accountId, target.id)
    }
    return c.body(null, 204)
  })

  return app
}
