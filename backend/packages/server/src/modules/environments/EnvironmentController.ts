import {
  bootstrapEnvironmentRepoContract,
  describeEnvironmentProviderContract,
  getEnvironmentAccessContract,
  getEnvironmentConnectionContract,
  getEnvironmentContract,
  listEnvironmentHandlersContract,
  listEnvironmentsContract,
  provisionEnvironmentContract,
  provisionTypeSchema,
  registerEnvironmentHandlerContract,
  registerEnvironmentProviderContract,
  removeCustomManifestTypeContract,
  teardownEnvironmentContract,
  testEnvironmentConnectionContract,
  unregisterEnvironmentHandlerContract,
  unregisterEnvironmentProviderContract,
  updateEnvironmentHandlerSecretsContract,
  updateEnvironmentSecretsContract,
  upsertCustomManifestTypeContract,
  validateEnvironmentRepoContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EnvironmentsModule } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { param } from '../../http/params.js'

/** Resolve the environment module or send a 503, returning null when unconfigured. */
function requireEnvironments<E extends AppEnv>(c: Context<E>): EnvironmentsModule | null {
  return c.get('container').environments ?? null
}

const unavailable = <E extends AppEnv>(c: Context<E>) =>
  c.json(
    { error: { code: 'unavailable', message: 'Environment integration is not configured' } },
    503,
  )

const notFound = <E extends AppEnv>(c: Context<E>) =>
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

  buildHonoRoute(app, getEnvironmentConnectionContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const connection = await env.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  buildHonoRoute(app, registerEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const { config, secrets } = c.req.valid('json')
    const connection = await env.connectionService.register(param(c, 'workspaceId'), {
      config,
      secrets,
    })
    return c.json(connection, 201)
  })

  buildHonoRoute(app, updateEnvironmentSecretsContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const connection = await env.connectionService.updateSecrets(
      param(c, 'workspaceId'),
      c.req.valid('json').secrets,
    )
    return c.json(connection, 200)
  })

  buildHonoRoute(app, unregisterEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    await env.connectionService.unregister(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // What the provider needs configured (native fields or the manifest's secret keys),
  // so the UI can render a connect form generically.
  buildHonoRoute(app, describeEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(
      await env.connectionService.describeProvider(param(c, 'workspaceId'), c.req.query('kind')),
      200,
    )
  })

  // Probe a candidate connection before saving (nothing persisted).
  buildHonoRoute(app, testEnvironmentConnectionContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(
      await env.connectionService.testConnection(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // Validate that a target repo satisfies the provider's config expectations (e.g. a
  // Kargo `.kargo.yml` is present + well-formed). Nothing persisted.
  buildHonoRoute(app, validateEnvironmentRepoContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(
      await env.connectionService.validateRepo(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // Mechanically bootstrap (and optionally agent-repair) the provider's config file
  // in a target repo from UI-collected variables.
  buildHonoRoute(app, bootstrapEnvironmentRepoContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(
      await env.connectionService.bootstrapRepo(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // ---- per-type infra handlers (the workspace "how") + custom-type catalog ----

  // The batched bundle the infra configurator loads: every registered handler + the
  // custom-manifest-type catalog (registered code types merged with workspace rows).
  buildHonoRoute(app, listEnvironmentHandlersContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const ws = param(c, 'workspaceId')
    const [handlers, customTypes] = await Promise.all([
      env.connectionService.listHandlers(ws),
      env.connectionService.listCustomTypes(ws),
    ])
    return c.json({ handlers, customTypes }, 200)
  })

  buildHonoRoute(app, registerEnvironmentHandlerContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const body = c.req.valid('json')
    const view = await env.connectionService.registerHandler(param(c, 'workspaceId'), body)
    return c.json(view, 201)
  })

  buildHonoRoute(app, updateEnvironmentHandlerSecretsContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const provisionType = v.parse(provisionTypeSchema, c.req.valid('param').provisionType)
    const manifestId = c.req.valid('query').manifestId ?? null
    const view = await env.connectionService.updateHandlerSecrets(
      param(c, 'workspaceId'),
      provisionType,
      manifestId,
      c.req.valid('json').secrets,
    )
    return c.json(view, 200)
  })

  buildHonoRoute(app, unregisterEnvironmentHandlerContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const provisionType = v.parse(provisionTypeSchema, c.req.valid('param').provisionType)
    const manifestId = c.req.valid('query').manifestId ?? null
    await env.connectionService.unregisterHandler(
      param(c, 'workspaceId'),
      provisionType,
      manifestId,
    )
    return c.body(null, 204)
  })

  // Workspace-defined custom-manifest-type catalog CRUD (the UI-editable half of the
  // `custom` provision-type catalog; the registered code providers are the other half).
  buildHonoRoute(app, upsertCustomManifestTypeContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const type = await env.connectionService.upsertCustomType(
      param(c, 'workspaceId'),
      c.req.valid('param').manifestId,
      c.req.valid('json'),
    )
    return c.json(type, 200)
  })

  buildHonoRoute(app, removeCustomManifestTypeContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    await env.connectionService.removeCustomType(
      param(c, 'workspaceId'),
      c.req.valid('param').manifestId,
    )
    return c.body(null, 204)
  })

  // ---- environment registry ----------------------------------------------

  buildHonoRoute(app, listEnvironmentsContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    return c.json(await env.provisioningService.listHandles(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getEnvironmentContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.provisioningService.getHandle(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return handle ? c.json(handle, 200) : notFound(c)
  })

  // The only endpoint that returns decrypted access credentials (over TLS).
  buildHonoRoute(app, getEnvironmentAccessContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.provisioningService.getHandleWithAccess(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return handle ? c.json(handle, 200) : notFound(c)
  })

  buildHonoRoute(app, provisionEnvironmentContract, async (c) => {
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

  buildHonoRoute(app, teardownEnvironmentContract, async (c) => {
    const env = requireEnvironments(c)
    if (!env) return unavailable(c)
    const handle = await env.teardownService.teardown(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return c.json(handle, 200)
  })

  return app
}
