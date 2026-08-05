import {
  createRiskPolicyContract,
  deleteRiskPolicyContract,
  listRiskPoliciesContract,
  reseedRiskPolicyContract,
  updateRiskPolicyContract,
} from '@cat-factory/contracts'
import type { RiskPoliciesModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the merge-preset module, or refuse with a 503 naming what isn't wired. */
function requireRiskPolicies<E extends AppEnv>(c: Context<E>): RiskPoliciesModule {
  return requireCapability(c.get('container').riskPolicies, 'Risk policies are not configured')
}

/**
 * CRUD for a workspace's merge threshold presets (the library a task picks its
 * auto-merge policy from). The default preset is seeded lazily on first list and
 * cannot be deleted/unset. Mounted under `/workspaces/:workspaceId`.
 */
export function riskPolicyController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'settings.manage', ['/risk-policies'])

  buildHonoRoute(app, listRiskPoliciesContract, async (c) => {
    const presets = requireRiskPolicies(c)
    return c.json(await presets.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createRiskPolicyContract, async (c) => {
    const presets = requireRiskPolicies(c)
    const preset = await presets.service.create(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(preset, 201)
  })

  buildHonoRoute(app, updateRiskPolicyContract, async (c) => {
    const presets = requireRiskPolicies(c)
    const preset = await presets.service.update(
      param(c, 'workspaceId'),
      c.req.valid('param').presetId,
      c.req.valid('json'),
    )
    return c.json(preset, 200)
  })

  buildHonoRoute(app, deleteRiskPolicyContract, async (c) => {
    const presets = requireRiskPolicies(c)
    await presets.service.remove(param(c, 'workspaceId'), c.req.valid('param').presetId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, reseedRiskPolicyContract, async (c) => {
    const presets = requireRiskPolicies(c)
    const preset = await presets.service.reseed(
      param(c, 'workspaceId'),
      c.req.valid('param').presetId,
    )
    return c.json(preset, 200)
  })

  return app
}
