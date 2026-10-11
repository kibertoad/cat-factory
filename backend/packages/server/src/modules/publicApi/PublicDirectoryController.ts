import {
  listDirectoryAccountMembershipsContract,
  listDirectoryChangesContract,
  listDirectoryReposContract,
  listDirectoryUsersContract,
  listDirectoryWorkspaceMembershipsContract,
  listDirectoryWorkspacesContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { authorizeAccount, refuse } from './publicApiAuth.js'

// The public DIRECTORY surface (`/api/v1/directory/*`): an account's workspaces, users,
// memberships and linked repositories, and the change feed that keeps a mirror of them current.
// Account-scoped, so no workspace header is read; the key's workspace reach becomes the reader's
// filter. The rules (visibility, cursor expiry, the snapshot watermark) are `DirectoryService`'s.
// Design: docs/initiatives/directory-sync.md.

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

  return app
}

/** The directory reader a key is: its account, and its workspace reach as the filter. */
function reader(auth: { accountId: string; workspaceIds: string[] | null }) {
  return { accountId: auth.accountId, workspaceIds: auth.workspaceIds }
}
