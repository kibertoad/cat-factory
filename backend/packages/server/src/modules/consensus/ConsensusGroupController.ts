import {
  createConsensusGroupContract,
  deleteConsensusGroupContract,
  listConsensusGroupsContract,
  updateConsensusGroupContract,
} from '@cat-factory/contracts'
import type { ConsensusGroupsModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the consensus-group module, or refuse with a 503 naming what isn't wired. */
function requireConsensusGroups<E extends AppEnv>(c: Context<E>): ConsensusGroupsModule {
  return requireCapability(
    c.get('container').consensusGroups,
    'The consensus group library is not configured',
  )
}

/**
 * CRUD over a workspace's consensus-GROUP library: the reusable, estimate-gated panels a
 * pipeline step escalates to. Gated on `settings.manage` like the model-preset library — a
 * group changes how much a run costs and which models see the work, the same blast radius as
 * the model mapping, so it is not a member-tier edit.
 *
 * Mounted under `/workspaces/:workspaceId`.
 */
export function consensusGroupController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/consensus-groups'])

  buildHonoRoute(app, listConsensusGroupsContract, async (c) => {
    const groups = requireConsensusGroups(c)
    return c.json(await groups.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createConsensusGroupContract, async (c) => {
    const groups = requireConsensusGroups(c)
    const group = await groups.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(group, 201)
  })

  buildHonoRoute(app, updateConsensusGroupContract, async (c) => {
    const groups = requireConsensusGroups(c)
    const group = await groups.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').groupId,
      c.req.valid('json'),
    )
    return c.json(group, 200)
  })

  buildHonoRoute(app, deleteConsensusGroupContract, async (c) => {
    const groups = requireConsensusGroups(c)
    await groups.service.remove(param(c, 'workspaceId'), c.req.valid('param').groupId)
    return c.body(null, 204)
  })

  return app
}
