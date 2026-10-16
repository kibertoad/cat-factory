import type { PublicApiKeyRecord } from '@cat-factory/kernel'
import {
  createPublicApiKeyContract,
  listPublicApiKeysContract,
  revokePublicApiKeyContract,
} from '@cat-factory/contracts'
import { type KeyViewer, keyReaches, managesMembershipKey } from '@cat-factory/integrations'
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type WorkspacePermission,
} from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requirePermission } from '../../http/workspaceAccess.js'
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
  // `rolesFor` rather than `requireMember`: a board admin who is not an account member must get
  // this 403, not a 404 naming the account.
  const roles = await c.get('container').accountService.rolesFor(accountId, user.id)
  if (!roles.includes('admin')) {
    throw new ForbiddenError(
      'Only an account admin can manage a key that reaches other workspaces',
      {
        reason: 'account_admin_required',
      },
    )
  }
}

/** Who is looking at this panel, for the keys that follow a person's memberships (`listReaching`). */
async function viewerOf<E extends AppEnv>(c: Context<E>, accountId: string): Promise<KeyViewer> {
  const user = c.get('user')
  if (!user) return { userId: null, accountAdmin: false }
  const roles = await c.get('container').accountService.rolesFor(accountId, user.id)
  return { userId: user.id, accountAdmin: roles.includes('admin') }
}

/**
 * Refuse a membership-following key that could not follow anyone, or that also names workspaces.
 * It needs no account admin: it can never reach past what its person can already do in the app.
 */
function assertFollowable(input: { actsAsSelf: boolean; workspaceIds: unknown }): void {
  if (!input.actsAsSelf) {
    throw new ValidationError(
      "A key that follows your workspaces has to run as you: only a person's own key has " +
        'memberships to follow',
      { reason: 'follows_memberships_requires_person' },
    )
  }
  if (input.workspaceIds !== undefined) {
    throw new ValidationError(
      'A key that follows your workspaces takes its reach from your memberships, so it names none',
      { reason: 'follows_memberships_with_workspaces' },
    )
  }
}

/** Whether the caller holds `permission` on this board, without refusing (dev-open holds all). */
function holds<E extends AppEnv>(c: Context<E>, permission: WorkspacePermission): boolean {
  const access = c.get('workspaceAccess')
  return access ? access.permissions.has(permission) : !c.get('user')
}

/** A membership-following key bound to the viewer: the one key a non-manager sees here. */
function ownKey(viewer: KeyViewer, key: PublicApiKeyRecord): boolean {
  return key.followsMemberships && viewer.userId !== null && key.actsAsUserId === viewer.userId
}

/** Resolve the public API-key store, or refuse with a 503 naming what isn't wired. */
function requirePublicApiKeys<E extends AppEnv>(c: Context<E>) {
  return requireCapability(c.get('container').publicApiKeys, 'Public API keys are not configured')
}

/** Public-API-key management routes, mounted under `/workspaces/:workspaceId`. */
export function publicApiKeyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // The board's keys are `secrets.manage`. A person who can run work here (`runs.execute`) also
  // manages their OWN membership-following key, which can never do more than they can in the app.
  buildHonoRoute(app, listPublicApiKeysContract, async (c) => {
    const publicApiKeys = requirePublicApiKeys(c)
    const workspaceId = param(c, 'workspaceId')
    const accountId = await requireAccountOf(c, workspaceId)
    const viewer = await viewerOf(c, accountId)
    const managesBoardKeys = holds(c, 'secrets.manage')
    if (!managesBoardKeys) requirePermission(c, 'runs.execute')
    const reaching = await publicApiKeys.listReaching(accountId, workspaceId, viewer)
    const keys = managesBoardKeys
      ? reaching
      : reaching.filter((key: PublicApiKeyRecord) => ownKey(viewer, key))
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
    const { label, scope, actsAsSelf, workspaceIds, followsMemberships } = c.req.valid('json')
    const createdByUserId = c.get('user')?.id ?? null
    // The binding reads the id off the SESSION, never off the body, so one person cannot mint a key
    // onto another's personal subscription. A dev-open mint has no session to bind to, so refuse
    // rather than silently drop the flag.
    if (actsAsSelf && !createdByUserId) {
      throw new ValidationError(
        'A key can only be bound to the person minting it, and this request has no signed-in ' +
          'user. Sign in and mint the key again, or mint it unbound.',
        { reason: 'acts_as_self_requires_session' },
      )
    }
    requirePermission(c, followsMemberships ? 'runs.execute' : 'secrets.manage')
    if (followsMemberships) assertFollowable({ actsAsSelf, workspaceIds })
    // Omitted means this board alone, which `secrets.manage` on it is enough for. Any other reach
    // spans boards this permission says nothing about, so it takes an account admin.
    const reach = followsMemberships
      ? []
      : workspaceIds === undefined
        ? [workspaceId]
        : workspaceIds
    if (!followsMemberships && !isOnly(reach, workspaceId)) {
      await requireAccountAdmin(c, accountId)
      await assertWorkspacesInAccount(container.workspaceService, accountId, reach)
    }
    const { record, secret } = await publicApiKeys.issue(
      {
        accountId,
        workspaceIds: reach,
        createdByUserId,
        actsAsUserId: actsAsSelf ? createdByUserId : null,
        followsMemberships,
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
    if (target?.followsMemberships) {
      if (managesMembershipKey(await viewerOf(c, accountId), target)) {
        await publicApiKeys.revoke(accountId, target.id)
      }
      return c.body(null, 204)
    }
    requirePermission(c, 'secrets.manage')
    if (target && keyReaches(target.workspaceIds, workspaceId)) {
      if (!isOnly(target.workspaceIds, workspaceId)) await requireAccountAdmin(c, accountId)
      await publicApiKeys.revoke(accountId, target.id)
    }
    return c.body(null, 204)
  })

  return app
}
