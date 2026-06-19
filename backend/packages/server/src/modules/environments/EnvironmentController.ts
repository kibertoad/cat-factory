import {
  provisionEnvironmentSchema,
  registerEnvironmentProviderSchema,
  updateEnvironmentSecretsSchema,
} from '@cat-factory/contracts'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EnvironmentsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'
import { jsonBody } from '../../http/validation.js'

/** Resolve the environment module or send a 503, returning null when unconfigured. */
function requireEnvironments(c: Context<AppEnv>): EnvironmentsModule | null {
  return c.get('container').environments ?? null
}

const unavailable = (c: Context<AppEnv>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Environment integration is not configured' } },
    503,
  )

const notFound = (c: Context<AppEnv>) =>
  c.json({ error: { code: 'not_found', message: 'Environment not found' } }, 404)

/**
 * Workspace-scoped environment endpoints: provider registration (manifest +
 * encrypted secret bundle), the environment registry, manual provision/teardown,
 * and the dedicated access endpoint that returns decrypted creds over TLS.
 * Mounted under `/workspaces/:workspaceId`.
 */
export function environmentController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  // ---- provider connection ------------------------------------------------

  app.get('/environments/connection', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const connection = await env.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection })
  })

  app.post('/environments/connection', jsonBody(registerEnvironmentProviderSchema), async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const { manifest, secrets } = c.req.valid('json')
    const connection = await env.connectionService.register(param(c, 'workspaceId'), {
      manifest,
      secrets,
    })
    return c.json(connection, 201)
  })

  app.put(
    '/environments/connection/secrets',
    jsonBody(updateEnvironmentSecretsSchema),
    async (c) => {
      const env = requireEnvironments(c)
      if (!env) return unavailable(c)
      const connection = await env.connectionService.updateSecrets(
        param(c, 'workspaceId'),
        c.req.valid('json').secrets,
      )
      return c.json(connection)
    },
  )

  app.delete('/environments/connection', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    await env.connectionService.unregister(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // ---- environment registry ----------------------------------------------

  app.get('/environments', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(await env.provisioningService.listHandles(param(c, 'workspaceId')))
  })

  app.get('/environments/:environmentId', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.provisioningService.getHandle(
      param(c, 'workspaceId'),
      param(c, 'environmentId'),
    )
    return handle ? c.json(handle) : notFound(c)
  })

  // The only endpoint that returns decrypted access credentials (over TLS).
  app.get('/environments/:environmentId/access', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.provisioningService.getHandleWithAccess(
      param(c, 'workspaceId'),
      param(c, 'environmentId'),
    )
    return handle ? c.json(handle) : notFound(c)
  })

  app.post('/environments/provision', jsonBody(provisionEnvironmentSchema), async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const { blockId, inputs } = c.req.valid('json')
    const handle = await env.provisioningService.provision({
      workspaceId: param(c, 'workspaceId'),
      blockId,
      inputs,
    })
    return c.json(handle, 201)
  })

  app.post('/environments/:environmentId/teardown', async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.teardownService.teardown(
      param(c, 'workspaceId'),
      param(c, 'environmentId'),
    )
    return c.json(handle)
  })

  return app
}
