import {
  deleteDirectoryWebhookContract,
  listDirectoryAccountMembershipsContract,
  listDirectoryChangesContract,
  listDirectoryReposContract,
  listDirectoryUsersContract,
  listDirectoryWorkspaceMembershipsContract,
  listDirectoryWebhooksContract,
  listDirectoryWorkspacesContract,
  putDirectoryWebhookContract,
} from '@cat-factory/contracts'
import { ForbiddenError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { authorizeAccount, refuse } from './publicApiAuth.js'

// The public DIRECTORY surface (`/api/v1/directory/*`): an account's workspaces, users,
// memberships and linked repositories, and the change feed that keeps a mirror of them current.
// Account-scoped, so no workspace header is read; the key's workspace reach becomes the reader's
// filter. The rules (visibility, cursor expiry, the snapshot watermark) are `DirectoryService`'s.
// Design: backend/docs/adr/0067-directory-sync.md.

export function publicDirectoryController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, listDirectoryChangesContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryChangesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { after, limit } = c.req.valid('query')
    const page = await c.get('container').directory.changes(reader(gate.auth), after ?? 0, limit)
    return c.json(page, 200)
  })

  buildHonoRoute(app, listDirectoryWorkspacesContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryWorkspacesContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { cursor, limit } = c.req.valid('query')
    return c.json(
      await c.get('container').directory.workspaces(reader(gate.auth), cursor, limit),
      200,
    )
  })

  buildHonoRoute(app, listDirectoryUsersContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryUsersContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { cursor, limit } = c.req.valid('query')
    return c.json(await c.get('container').directory.users(reader(gate.auth), cursor, limit), 200)
  })

  buildHonoRoute(app, listDirectoryAccountMembershipsContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryAccountMembershipsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { cursor, limit } = c.req.valid('query')
    const page = await c
      .get('container')
      .directory.accountMemberships(reader(gate.auth), cursor, limit)
    return c.json(page, 200)
  })

  buildHonoRoute(app, listDirectoryWorkspaceMembershipsContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryWorkspaceMembershipsContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { cursor, limit } = c.req.valid('query')
    const page = await c
      .get('container')
      .directory.workspaceMemberships(reader(gate.auth), cursor, limit)
    return c.json(page, 200)
  })

  buildHonoRoute(app, listDirectoryReposContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryReposContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const { cursor, limit } = c.req.valid('query')
    return c.json(await c.get('container').directory.repos(reader(gate.auth), cursor, limit), 200)
  })

  // ---- Directory webhooks: account-level push endpoints --------------------------------------
  // `admin` and account-wide only: an endpoint receives every directory change in the account, so
  // a key limited to some workspaces could otherwise read the rest through a push it registered.

  buildHonoRoute(app, listDirectoryWebhooksContract, async (c) => {
    const gate = await authorizeAccount(c, listDirectoryWebhooksContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const accountId = requireAccountWide(gate.auth)
    return c.json({ webhooks: await webhooks(c).list(accountId) }, 200)
  })

  buildHonoRoute(app, putDirectoryWebhookContract, async (c) => {
    const gate = await authorizeAccount(c, putDirectoryWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const accountId = requireAccountWide(gate.auth)
    const { webhookId } = c.req.valid('param')
    return c.json(await webhooks(c).put(accountId, webhookId, c.req.valid('json')), 200)
  })

  buildHonoRoute(app, deleteDirectoryWebhookContract, async (c) => {
    const gate = await authorizeAccount(c, deleteDirectoryWebhookContract.minScope)
    if ('fail' in gate) return refuse(c, gate.fail)
    const accountId = requireAccountWide(gate.auth)
    await webhooks(c).delete(accountId, c.req.valid('param').webhookId)
    return c.body(null, 204)
  })

  return app
}

function webhooks<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    c.get('container').directoryWebhooks,
    'Directory webhooks are not served here: they need ENCRYPTION_KEY to seal signing secrets, and a mothership-mode node leaves them to the mothership',
  )
}

/** The key's account, refusing a key limited to some workspaces. */
function requireAccountWide(auth: { accountId: string; workspaceIds: string[] | null }): string {
  if (auth.workspaceIds !== null) {
    throw new ForbiddenError('Directory webhooks need a key that reaches every workspace', {
      reason: 'account_scope_required',
    })
  }
  return auth.accountId
}

/** The directory reader a key is: its account, and its workspace reach as the filter. */
function reader(auth: { accountId: string; workspaceIds: string[] | null }) {
  return { accountId: auth.accountId, workspaceIds: auth.workspaceIds }
}
