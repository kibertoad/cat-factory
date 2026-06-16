import { createWorkspaceSchema, renameWorkspaceSchema } from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../infrastructure/http/types'
import { param } from '../../infrastructure/http/params'
import { jsonBody } from '../../infrastructure/http/validation'

/** The signed-in user, narrowed to what the tenancy layer needs. */
function accountUser(c: Context<AppEnv>) {
  const user = c.get('user')
  return user ? { id: user.id, login: user.login, name: user.name } : null
}

/** Board (workspace) lifecycle and full-snapshot retrieval. */
export function workspaceController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Boards visible to the signed-in user: those in any account they belong to,
  // plus any legacy board they personally own. When auth is disabled (`user`
  // unset) the scope is null → no scoping (every board, dev behaviour).
  app.get('/workspaces', async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    if (!user) return c.json(await container.workspaceService.list(null))
    await container.accountService.ensurePersonalAccount(user)
    const accountIds = await container.accountService.accessibleAccountIds(user.id)
    return c.json(await container.workspaceService.list({ accountIds, ownerUserId: user.id }))
  })

  app.post('/workspaces', jsonBody(createWorkspaceSchema), async (c) => {
    const container = c.get('container')
    const user = accountUser(c)
    const body = c.req.valid('json')

    // Resolve the owning account: an explicit one the caller belongs to, else the
    // caller's personal account; unscoped when there's no signed-in user (dev).
    let accountId: string | null = null
    if (user) {
      if (body.accountId) {
        // Membership is required — a non-member is told the account doesn't exist.
        await container.accountService.requireMember(body.accountId, user.id)
        accountId = body.accountId
      } else {
        accountId = (await container.accountService.ensurePersonalAccount(user)).id
      }
    } else if (body.accountId) {
      accountId = body.accountId
    }

    const snapshot = await container.workspaceService.create(body, user?.id ?? null, accountId)
    const spend = await container.spendService.status()
    return c.json({ ...snapshot, spend }, 201)
  })

  app.get('/workspaces/:workspaceId', async (c) => {
    const container = c.get('container')
    const snapshot = await container.workspaceService.snapshot(param(c, 'workspaceId'))
    const spend = await container.spendService.status()
    return c.json({ ...snapshot, spend })
  })

  app.patch('/workspaces/:workspaceId', jsonBody(renameWorkspaceSchema), async (c) => {
    const workspace = await c
      .get('container')
      .workspaceService.rename(param(c, 'workspaceId'), c.req.valid('json').name)
    return c.json(workspace)
  })

  app.delete('/workspaces/:workspaceId', async (c) => {
    await c.get('container').workspaceService.delete(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  return app
}
