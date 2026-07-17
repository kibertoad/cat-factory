import {
  addWorkspaceMemberContract,
  listWorkspaceMembersContract,
  removeWorkspaceMemberContract,
  setWorkspaceAccessModeContract,
  setWorkspaceMemberRoleContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requirePermission } from '../../http/workspaceAccess.js'

// ---------------------------------------------------------------------------
// Workspace-membership management (workspace-rbac initiative, slice 5). All routes are
// mounted under `/workspaces/:workspaceId`, so the shared `mountAuthGate` has already
// resolved the caller's effective access and enforced the method-shaped viewer write
// floor. This controller adds ONLY the admin-tier permission check (`members.manage`)
// for the roster/access-mode WRITES; the roster GET is open to any resolved role
// (`workspace.read`, satisfied by the gate resolution itself).
//
// The service is present only when the facade wired the workspace-member repository (both
// do); absent ⇒ every route reports 503 rather than 500-ing on an undefined service.
// ---------------------------------------------------------------------------

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json({ error: { code: 'unavailable', message: 'Workspace membership is not configured' } }, 503)

export function workspaceMemberController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // Roster — any resolved role may read it (gate resolution already guaranteed ≥ viewer).
  buildHonoRoute(app, listWorkspaceMembersContract, async (c) => {
    const service = c.get('container').workspaceMemberService
    if (!service) return unavailable(c)
    return c.json(await service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, addWorkspaceMemberContract, async (c) => {
    const service = c.get('container').workspaceMemberService
    if (!service) return unavailable(c)
    requirePermission(c, 'members.manage')
    const body = c.req.valid('json')
    const member = await service.add(
      param(c, 'workspaceId'),
      body.userId,
      body.role,
      c.get('user')?.id ?? null,
    )
    return c.json(member, 201)
  })

  buildHonoRoute(app, setWorkspaceMemberRoleContract, async (c) => {
    const service = c.get('container').workspaceMemberService
    if (!service) return unavailable(c)
    requirePermission(c, 'members.manage')
    const { workspaceId, userId } = c.req.valid('param')
    const member = await service.setRole(workspaceId, userId, c.req.valid('json').role)
    return c.json(member, 200)
  })

  buildHonoRoute(app, removeWorkspaceMemberContract, async (c) => {
    const service = c.get('container').workspaceMemberService
    if (!service) return unavailable(c)
    requirePermission(c, 'members.manage')
    const { workspaceId, userId } = c.req.valid('param')
    await service.remove(workspaceId, userId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, setWorkspaceAccessModeContract, async (c) => {
    const service = c.get('container').workspaceMemberService
    if (!service) return unavailable(c)
    requirePermission(c, 'members.manage')
    const workspace = await service.setAccessMode(
      param(c, 'workspaceId'),
      c.req.valid('json').accessMode,
    )
    return c.json(workspace, 200)
  })

  return app
}
