import {
  getAccountOutcomeStoragePolicyContract,
  getOutcomeStoragePolicyContract,
  setAccountOutcomeStoragePolicyContract,
  setOutcomeStoragePolicyContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import { mountAccountMembership } from '../../http/accountAccess.js'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { param } from '../../http/params.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'

type Scope = 'account' | 'workspace'

/** Every top-level path this controller serves, gated at whichever tier owns the scope. */
const GUARDED_RESOURCES = ['/outcome-storage-policy'] as const

function requireStoragePolicy<E extends AppEnv>(c: Context<E>) {
  const projects = requireCapability(c.get('container').projects, 'Projects are not configured')
  return requireCapability(projects.storagePolicy, 'The outcome-storage policy is not configured')
}

/**
 * The outcome-storage policy tiers, mounted twice so each tier is set at the scope that owns it.
 * A board reads every tier that applies to it and sets its own or a project it mounts
 * (`settings.manage`); the account tier is set under the account (membership, as the account's
 * other libraries are). Both mounts gate this controller's own path only.
 */
export function outcomeStoragePolicyController(scope: Scope): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  if (scope === 'account') {
    mountAccountMembership(app, GUARDED_RESOURCES, 'Sign in to manage outcome storage')
    buildHonoRoute(app, getAccountOutcomeStoragePolicyContract, async (c) => {
      const policy = await requireStoragePolicy(c).getAccount(param(c, 'accountId'))
      return c.json({ policy }, 200)
    })
    buildHonoRoute(app, setAccountOutcomeStoragePolicyContract, async (c) => {
      const { policy } = c.req.valid('json')
      const stored = await requireStoragePolicy(c).setAccount(param(c, 'accountId'), policy)
      return c.json({ policy: stored }, 200)
    })
    return app
  }
  mountWorkspacePermission(app, 'settings.manage', GUARDED_RESOURCES)
  buildHonoRoute(app, getOutcomeStoragePolicyContract, async (c) => {
    const { projectId } = c.req.valid('query')
    return c.json(await requireStoragePolicy(c).view(param(c, 'workspaceId'), projectId), 200)
  })
  buildHonoRoute(app, setOutcomeStoragePolicyContract, async (c) => {
    const view = await requireStoragePolicy(c).set(param(c, 'workspaceId'), c.req.valid('json'))
    return c.json(view, 200)
  })
  return app
}
