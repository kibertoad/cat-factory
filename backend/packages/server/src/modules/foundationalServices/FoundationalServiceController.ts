import {
  createFoundationalServiceContract,
  deleteFoundationalServiceContract,
  foundationalServiceSourceStatusContract,
  getFoundationalServiceContractsContract,
  linkFoundationalServiceSourceContract,
  listFoundationalServiceSourcesContract,
  listFoundationalServiceSuppressionsContract,
  listFoundationalServicesContract,
  resolvedFoundationalServicesContract,
  restoreFoundationalServiceContract,
  suppressFoundationalServiceContract,
  syncFoundationalServiceSourceContract,
  unlinkFoundationalServiceSourceContract,
  updateFoundationalServiceContract,
} from '@cat-factory/contracts'
import type { FoundationalServiceOwnerKind } from '@cat-factory/contracts'
import type { FoundationalServiceModule } from '@cat-factory/orchestration'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { requireCapability, requireUser } from '../../http/guards.js'
import { requireWorkspacePermission } from '../../http/workspaceAccess.js'

type Scope = 'account' | 'workspace'

/** Resolve the foundational-services module or send a 503 when unconfigured. */
function requireCatalog<E extends AppEnv>(c: Context<E>): FoundationalServiceModule {
  return requireCapability(
    c.get('container').foundationalServices,
    'The foundational-services catalog is not configured',
  )
}

/**
 * The repo-source service, wired only when the GitHub integration is too — a SECOND capability
 * behind the same module, so it gets its own accessor rather than a guard restated at each of
 * the five source routes.
 */
function requireSources<E extends AppEnv>(c: Context<E>) {
  return requireCapability(
    requireCatalog(c).sourceService,
    'Repo-sourced foundational services require the GitHub integration to be configured',
  )
}

/**
 * The foundational-services API (backend/docs/adr/0031-foundational-services.md), mounted TWICE —
 * once under `/accounts/:accountId` and once under `/workspaces/:workspaceId` — so a tier's
 * services and repo sources are managed at the scope that owns them, exactly like the
 * prompt-fragment library.
 *
 * Workspace routes are authorized by the global per-workspace gate in `app.ts` plus the
 * admin-tier `settings.manage` permission (the catalog is workspace configuration); account
 * routes guard on account membership here. The MERGED read — what an agent actually sees — is
 * workspace-only, because a board is what runs agents; an account inspects what it inherits
 * from the deployment's registered tier through the suppression list, which both scopes serve.
 */
export function foundationalServiceController(scope: Scope): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  const ownerId = <E extends AppEnv>(c: Context<E>) =>
    scope === 'account' ? param(c, 'accountId') : param(c, 'workspaceId')
  const ownerKind: FoundationalServiceOwnerKind = scope

  if (scope === 'account') {
    app.use('/foundational-services', accountGuard)
    app.use('/foundational-services/*', accountGuard)
    app.use('/foundational-service-sources', accountGuard)
    app.use('/foundational-service-sources/*', accountGuard)
  }

  if (scope === 'workspace') {
    app.use('*', requireWorkspacePermission('settings.manage'))
  }

  // ---- services (this tier, raw — not merged) -----------------------------

  buildHonoRoute(app, listFoundationalServicesContract, async (c) => {
    const module = requireCatalog(c)
    return c.json(await module.catalogService.listTier(ownerKind, ownerId(c)), 200)
  })

  buildHonoRoute(app, createFoundationalServiceContract, async (c) => {
    const module = requireCatalog(c)
    const service = await module.catalogService.create(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(service, 201)
  })

  buildHonoRoute(app, updateFoundationalServiceContract, async (c) => {
    const module = requireCatalog(c)
    const service = await module.catalogService.update(
      ownerKind,
      ownerId(c),
      c.req.valid('param').serviceId,
      c.req.valid('json'),
    )
    return c.json(service, 200)
  })

  buildHonoRoute(app, deleteFoundationalServiceContract, async (c) => {
    const module = requireCatalog(c)
    await module.catalogService.remove(ownerKind, ownerId(c), c.req.valid('param').serviceId)
    return c.body(null, 204)
  })

  // ---- opting a tier out of what it INHERITS ------------------------------
  // Mounted at both scopes: a board inherits from its account, and either tier inherits the
  // deployment's code-registered `builtin` services.

  buildHonoRoute(app, listFoundationalServiceSuppressionsContract, async (c) => {
    const module = requireCatalog(c)
    return c.json(await module.catalogService.listSuppressions(ownerKind, ownerId(c)), 200)
  })

  buildHonoRoute(app, suppressFoundationalServiceContract, async (c) => {
    const module = requireCatalog(c)
    await module.catalogService.suppress(ownerKind, ownerId(c), c.req.valid('param').serviceId)
    return c.body(null, 204)
  })

  buildHonoRoute(app, restoreFoundationalServiceContract, async (c) => {
    const module = requireCatalog(c)
    await module.catalogService.restoreInherited(
      ownerKind,
      ownerId(c),
      c.req.valid('param').serviceId,
    )
    return c.body(null, 204)
  })

  // ---- the merged catalog + the lazy contract read ------------------------

  if (scope === 'workspace') {
    buildHonoRoute(app, resolvedFoundationalServicesContract, async (c) => {
      const module = requireCatalog(c)
      return c.json(await module.catalogService.resolve(ownerId(c)), 200)
    })

    // The lazy read, resolved through the same tier merge an agent's context uses — so what a
    // human inspects here is byte-for-byte what a consumer step would be handed.
    buildHonoRoute(app, getFoundationalServiceContractsContract, async (c) => {
      const module = requireCatalog(c)
      const serviceId = c.req.valid('param').serviceId
      const documents = await module.catalogService.contractsFor(ownerId(c), [serviceId])
      return c.json(documents.get(serviceId) ?? [], 200)
    })
  }

  // ---- repo sources -------------------------------------------------------

  buildHonoRoute(app, listFoundationalServiceSourcesContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.list(ownerKind, ownerId(c)), 200)
  })

  buildHonoRoute(app, linkFoundationalServiceSourceContract, async (c) => {
    const sources = requireSources(c)
    const source = await sources.link(ownerKind, ownerId(c), c.req.valid('json'))
    return c.json(source, 201)
  })

  buildHonoRoute(app, unlinkFoundationalServiceSourceContract, async (c) => {
    const sources = requireSources(c)
    await sources.unlink(ownerKind, ownerId(c), c.req.valid('param').id)
    return c.body(null, 204)
  })

  buildHonoRoute(app, foundationalServiceSourceStatusContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.status(ownerKind, ownerId(c), c.req.valid('param').id), 200)
  })

  buildHonoRoute(app, syncFoundationalServiceSourceContract, async (c) => {
    const sources = requireSources(c)
    return c.json(await sources.sync(ownerKind, ownerId(c), c.req.valid('param').id), 200)
  })

  return app
}

/** Guard an account-scoped request: require sign-in + membership (404 otherwise). */
async function accountGuard(c: Context<AppEnv>, next: () => Promise<void>) {
  const user = requireUser(c, 'Sign in to manage foundational services')
  // requireMember throws NotFoundError (→ 404) when the user isn't a member.
  await c.get('container').accountService.requireMember(param(c, 'accountId'), user.id)
  await next()
}
