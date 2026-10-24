import {
  describeRunnerPoolProviderContract,
  getRunnerPoolConnectionContract,
  registerRunnerPoolContract,
  testRunnerPoolConnectionContract,
  unregisterRunnerPoolContract,
  updateRunnerPoolSecretsContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RunnersModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'

/** Resolve the runners module, or refuse with a 503 naming what isn't wired. */
function requireRunners<E extends AppEnv>(c: Context<E>): RunnersModule {
  return requireCapability(c.get('container').runners, 'Runner pool integration is not configured')
}

/**
 * Workspace-scoped runner-pool endpoints: registering the pool scheduler manifest
 * plus its encrypted secret bundle, rotating the secrets, and unregistering. The
 * actual job dispatch happens transparently through the execution engine once a
 * pool is registered. Mounted under `/workspaces/:workspaceId`.
 */
export function runnerPoolController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  mountWorkspacePermission(app, 'integrations.manage', ['/runner-pool'])

  buildHonoRoute(app, getRunnerPoolConnectionContract, async (c) => {
    const runners = requireRunners(c)
    const connection = await runners.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  buildHonoRoute(app, registerRunnerPoolContract, async (c) => {
    const runners = requireRunners(c)
    const { config, secrets } = c.req.valid('json')
    const connection = await runners.connectionService.register(param(c, 'workspaceId'), {
      config,
      secrets,
    })
    return c.json(connection, 201)
  })

  buildHonoRoute(app, updateRunnerPoolSecretsContract, async (c) => {
    const runners = requireRunners(c)
    const connection = await runners.connectionService.updateSecrets(
      param(c, 'workspaceId'),
      c.req.valid('json').secrets,
    )
    return c.json(connection, 200)
  })

  buildHonoRoute(app, unregisterRunnerPoolContract, async (c) => {
    const runners = requireRunners(c)
    const workspaceId = param(c, 'workspaceId')
    await runners.connectionService.unregister(workspaceId)
    // The explicit "none" marker: without it the board would fall straight through to its account's
    // pool. Written through the settings service so the shared settings cache is invalidated. With
    // no settings module the account tier is not wired either (it reads the same marker).
    if (!c.req.valid('query').fallBackToAccount) {
      await c
        .get('container')
        .settings?.service.update(workspaceId, { inheritAccountRunnerPool: false })
    }
    return c.body(null, 204)
  })

  buildHonoRoute(app, describeRunnerPoolProviderContract, async (c) => {
    const runners = requireRunners(c)
    return c.json(
      await runners.connectionService.describeProvider(
        param(c, 'workspaceId'),
        c.req.query('kind'),
      ),
      200,
    )
  })

  buildHonoRoute(app, testRunnerPoolConnectionContract, async (c) => {
    const runners = requireRunners(c)
    return c.json(
      await runners.connectionService.testConnection(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  return app
}
