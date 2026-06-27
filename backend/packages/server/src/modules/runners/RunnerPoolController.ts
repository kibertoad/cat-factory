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
import { param } from '../../http/params.js'

/** Resolve the runners module or send a 503, returning null when unconfigured. */
function requireRunners<E extends AppEnv>(c: Context<E>): RunnersModule | null {
  return c.get('container').runners ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Runner pool integration is not configured' } },
    503,
  )

/**
 * Workspace-scoped runner-pool endpoints: registering the pool scheduler manifest
 * plus its encrypted secret bundle, rotating the secrets, and unregistering. The
 * actual job dispatch happens transparently through the execution engine once a
 * pool is registered. Mounted under `/workspaces/:workspaceId`.
 */
export function runnerPoolController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  buildHonoRoute(app, getRunnerPoolConnectionContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const connection = await runners.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  buildHonoRoute(app, registerRunnerPoolContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const { manifest, secrets } = c.req.valid('json')
    const connection = await runners.connectionService.register(param(c, 'workspaceId'), {
      manifest,
      secrets,
    })
    return c.json(connection, 201)
  })

  buildHonoRoute(app, updateRunnerPoolSecretsContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const connection = await runners.connectionService.updateSecrets(
      param(c, 'workspaceId'),
      c.req.valid('json').secrets,
    )
    return c.json(connection, 200)
  })

  buildHonoRoute(app, unregisterRunnerPoolContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    await runners.connectionService.unregister(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  buildHonoRoute(app, describeRunnerPoolProviderContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    return c.json(await runners.connectionService.describeProvider(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, testRunnerPoolConnectionContract, async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    return c.json(
      await runners.connectionService.testConnection(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  return app
}
