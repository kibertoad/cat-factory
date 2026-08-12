import {
  cloneRiskPolicyContract,
  createRiskPolicyContract,
  deleteRiskPolicyContract,
  listRiskPoliciesContract,
  listRiskPolicySuppressionsContract,
  reseedRiskPolicyContract,
  restoreRiskPolicyContract,
  suppressRiskPolicyContract,
  updateRiskPolicyContract,
} from '@cat-factory/contracts'
import { UnauthorizedError } from '@cat-factory/kernel'
import type { AccountRiskPolicyService, RiskPoliciesModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

type Scope = 'account' | 'workspace'

/** Every TOP-LEVEL path this controller serves, gated at whichever tier owns the scope. */
const GUARDED_RESOURCES = ['/risk-policies', '/risk-policy-suppressions'] as const

/** Resolve the risk-policy module, or refuse with a 503 naming what isn't wired. */
function requireRiskPolicies<E extends AppEnv>(c: Context<E>): RiskPoliciesModule {
  return requireCapability(c.get('container').riskPolicies, 'Risk policies are not configured')
}

/**
 * The ACCOUNT tier, a capability behind a capability: it is wired only where the facade has an
 * account-tier store, so it gets its own accessor rather than a message borrowed from its parent,
 * which would name a library the operator has already configured.
 */
function requireAccountRiskPolicies<E extends AppEnv>(c: Context<E>): AccountRiskPolicyService {
  return requireCapability(
    requireRiskPolicies(c).accountService,
    'Account-wide risk policies are not configured',
  )
}

/**
 * Risk policy CRUD, mounted TWICE — once under `/accounts/:accountId` and once under
 * `/workspaces/:workspaceId` — so each tier is managed at the scope that owns it (ADR 0055).
 *
 * A board's list is its own policies MERGED with the ones it inherits from its account, so the four
 * inheritance routes live on the workspace mount alone: an account has no tier above it to clone
 * from or hide. Reseed is workspace-only for the same reason in reverse — the built-in catalog is
 * copied into boards, so only a board has a built-in to restore.
 *
 * Workspace routes are `settings.manage` (the library is board configuration); account routes guard
 * on account membership here, exactly as the fragment library's do. Both mounts name this
 * controller's OWN paths from one list, so neither can gate a subset the other doesn't: each shared
 * prefix carries sibling controllers, and a `use('*')` inside a sub-app lands on `<prefix>/*` and
 * would authorize their routes too.
 */
export function riskPolicyController(scope: Scope): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  if (scope === 'account') {
    for (const resource of GUARDED_RESOURCES) {
      app.use(resource, accountGuard)
      app.use(`${resource}/*`, accountGuard)
    }
  } else {
    mountWorkspacePermission(app, 'settings.manage', GUARDED_RESOURCES)
  }

  // ---- the tier's own library ---------------------------------------------

  buildHonoRoute(app, listRiskPoliciesContract, async (c) => {
    if (scope === 'account') {
      return c.json(await requireAccountRiskPolicies(c).list(param(c, 'accountId')), 200)
    }
    const policies = requireRiskPolicies(c)
    return c.json(await policies.service.list(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, createRiskPolicyContract, async (c) => {
    const input = c.req.valid('json')
    if (scope === 'account') {
      const created = await requireAccountRiskPolicies(c).create(param(c, 'accountId'), input)
      return c.json(created, 201)
    }
    const policies = requireRiskPolicies(c)
    const created = await policies.service.create(param(c, 'workspaceId'), input)
    return c.json(created, 201)
  })

  buildHonoRoute(app, updateRiskPolicyContract, async (c) => {
    const { presetId } = c.req.valid('param')
    const patch = c.req.valid('json')
    if (scope === 'account') {
      const updated = await requireAccountRiskPolicies(c).update(
        param(c, 'accountId'),
        presetId,
        patch,
      )
      return c.json(updated, 200)
    }
    const policies = requireRiskPolicies(c)
    const updated = await policies.service.update(param(c, 'workspaceId'), presetId, patch)
    return c.json(updated, 200)
  })

  buildHonoRoute(app, deleteRiskPolicyContract, async (c) => {
    const { presetId } = c.req.valid('param')
    if (scope === 'account') {
      await requireAccountRiskPolicies(c).remove(param(c, 'accountId'), presetId)
      return c.body(null, 204)
    }
    const policies = requireRiskPolicies(c)
    await policies.service.remove(param(c, 'workspaceId'), presetId)
    return c.body(null, 204)
  })

  // ---- inheritance (workspace mount only) ---------------------------------

  if (scope === 'workspace') {
    buildHonoRoute(app, reseedRiskPolicyContract, async (c) => {
      const policies = requireRiskPolicies(c)
      const preset = await policies.service.reseed(
        param(c, 'workspaceId'),
        c.req.valid('param').presetId,
      )
      return c.json(preset, 200)
    })

    buildHonoRoute(app, cloneRiskPolicyContract, async (c) => {
      const policies = requireRiskPolicies(c)
      const clone = await policies.service.clone(
        param(c, 'workspaceId'),
        c.req.valid('param').presetId,
        c.req.valid('json'),
      )
      return c.json(clone, 201)
    })

    buildHonoRoute(app, suppressRiskPolicyContract, async (c) => {
      const policies = requireRiskPolicies(c)
      await policies.service.suppress(param(c, 'workspaceId'), c.req.valid('param').presetId)
      return c.body(null, 204)
    })

    buildHonoRoute(app, restoreRiskPolicyContract, async (c) => {
      const policies = requireRiskPolicies(c)
      await policies.service.restoreInherited(
        param(c, 'workspaceId'),
        c.req.valid('param').presetId,
      )
      return c.body(null, 204)
    })

    buildHonoRoute(app, listRiskPolicySuppressionsContract, async (c) => {
      const policies = requireRiskPolicies(c)
      return c.json(await policies.service.listSuppressions(param(c, 'workspaceId')), 200)
    })
  }

  return app
}

/**
 * Guard an account-scoped request: require sign-in + membership (404 otherwise).
 *
 * The sign-in floor is a hard denial rather than an allow-all, including under dev-open: unlike the
 * workspace gate, this tier never passes through anonymously, and `requireMember` throws the
 * existence-hiding 404 for a caller outside the account.
 */
async function accountGuard(c: Context<AppEnv>, next: () => Promise<void>) {
  const user = c.get('user')
  if (!user) throw new UnauthorizedError('Sign in to manage risk policies')
  await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
  await next()
}
