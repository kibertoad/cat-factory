import {
  registerRunnerPoolSchema,
  testRunnerPoolConnectionSchema,
  updateRunnerPoolSecretsSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { RunnersModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the runners module or send a 503, returning null when unconfigured. */
function requireRunners(c: Context<AppEnv>): RunnersModule | null {
  return c.get('container').runners ?? null
}

const unavailable = (c: Context<AppEnv>) =>
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

  app.get('/runner-pool/connection', async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const connection = await runners.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection })
  })

  app.post('/runner-pool/connection', jsonBody(registerRunnerPoolSchema), async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const { manifest, secrets } = c.req.valid('json')
    const connection = await runners.connectionService.register(param(c, 'workspaceId'), {
      manifest,
      secrets,
    })
    return c.json(connection, 201)
  })

  app.put('/runner-pool/connection/secrets', jsonBody(updateRunnerPoolSecretsSchema), async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    const connection = await runners.connectionService.updateSecrets(
      param(c, 'workspaceId'),
      c.req.valid('json').secrets,
    )
    return c.json(connection)
  })

  app.delete('/runner-pool/connection', async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    await runners.connectionService.unregister(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  app.get('/runner-pool/provider', async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    return c.json(await runners.connectionService.describeProvider(param(c, 'workspaceId')))
  })

  app.post('/runner-pool/connection/test', jsonBody(testRunnerPoolConnectionSchema), async (c) => {
    const runners = requireRunners(c)
    if (!runners) return unavailable(c)
    return c.json(
      await runners.connectionService.testConnection(param(c, 'workspaceId'), c.req.valid('json')),
    )
  })

  return app
}
