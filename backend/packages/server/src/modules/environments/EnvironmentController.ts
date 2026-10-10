import {
  bootstrapEnvironmentRepoContract,
  describeEnvironmentProviderContract,
  detectFrontendConfigContract,
  detectServiceProvisioningContract,
  getEnvironmentAccessContract,
  getEnvironmentTestContract,
  startEnvironmentTestContract,
  stopEnvironmentTestContract,
  getEnvironmentConnectionContract,
  getEnvironmentContract,
  listEnvironmentHandlersContract,
  listEnvironmentsContract,
  provisionEnvironmentContract,
  provisionTypeSchema,
  registerEnvironmentHandlerContract,
  registerEnvironmentProviderContract,
  removeCustomManifestTypeContract,
  repairCustomManifestContract,
  teardownEnvironmentContract,
  testEnvironmentConnectionContract,
  testEnvironmentHandlerContract,
  unregisterEnvironmentHandlerContract,
  unregisterEnvironmentProviderContract,
  updateEnvironmentHandlerSecretsContract,
  updateEnvironmentSecretsContract,
  upsertCustomManifestTypeContract,
  validateEnvironmentRepoContract,
} from '@cat-factory/contracts'
import { buildHonoRoute } from '@toad-contracts/hono'
import { optionalJsonBody } from '../../http/optionalJsonBody.js'
import * as v from 'valibot'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { EnvironmentsModule, EnvironmentTestService } from '@cat-factory/orchestration'
import type { AppEnv } from '../../http/env.js'
import { mountWorkspacePermission } from '../../http/workspaceAccess.js'
import { param } from '../../http/params.js'
import { requireCapability } from '../../http/guards.js'
import {
  personalGateForAgentKind,
  readPersonalPassword,
} from '../providers/personalCredentialGate.js'

/** Resolve the environment module, or refuse with a 503 naming what isn't wired. */
function requireEnvironments<E extends AppEnv>(c: Context<E>): EnvironmentsModule {
  return requireCapability(
    c.get('container').environments,
    'Environment integration is not configured',
  )
}

/**
 * The personal-credential gate for an AGENT DRY RUN start, as a CLOSURE the service calls once its
 * own refusals are past: whose credential the run may use, and how to mint its activation.
 *
 * Deferred rather than resolved here, because resolving it is what raises the
 * `428 credential_required` the SPA opens its password modal on. Called eagerly at this edge, a dry
 * run that could never have started (a self-test already running for the frame, a model this
 * deployment cannot dispatch) demanded a password first and answered the 409 second, so the
 * developer paid for an unlock to be told the run was never possible.
 *
 * The kind comes from the service, because the prober's model is resolved under a kind that
 * depends on the frame's TYPE (a browser prober for a frontend frame, an HTTP one otherwise) and
 * the gate and the dispatch must ask about the same one. `null` means there is no dry run to gate
 * at all (see `probeAgentKind`): nothing to unlock, and `startTest` then answers with the 409 that
 * names what is actually wrong, which is a better error than one about a credential.
 */
function gateAgentProbe<E extends AppEnv>(
  c: Context<E>,
  service: EnvironmentTestService,
  workspaceId: string,
  blockId: string,
): () => Promise<((runId: string) => Promise<void>) | undefined> {
  return async () => {
    const agentKind = await service.probeAgentKind(workspaceId, blockId)
    if (!agentKind) return undefined
    const { activate } = await personalGateForAgentKind(
      c.get('container'),
      workspaceId,
      blockId,
      agentKind,
      c.get('user'),
      readPersonalPassword(c),
    )
    return activate
  }
}

/**
 * The self-test service, present only when its run store + a git provider are wired. It keeps
 * its OWN refusal message rather than borrowing `requireEnvironments`': a deployment can have
 * the environment integration fully wired and still not host the self-test, so naming the
 * module here would tell the operator to fix something that is already configured.
 */
function requireEnvironmentTest<E extends AppEnv>(c: Context<E>): EnvironmentTestService {
  return requireCapability(
    c.get('container').environments?.environmentTest,
    'Ephemeral-environment self-testing is not configured for this deployment',
  )
}

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
  mountWorkspacePermission(app, 'integrations.manage', [
    '/environments',
    '/environment-tests',
    '/blocks/:blockId/environment-test',
  ])

  // ---- provider connection ------------------------------------------------

  buildHonoRoute(app, getEnvironmentConnectionContract, async (c) => {
    const env = requireEnvironments(c)
    const connection = await env.connectionService.getConnection(param(c, 'workspaceId'))
    return c.json({ connection }, 200)
  })

  buildHonoRoute(app, registerEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    const { config, secrets } = c.req.valid('json')
    const connection = await env.connectionService.register(param(c, 'workspaceId'), {
      config,
      secrets,
    })
    return c.json(connection, 201)
  })

  buildHonoRoute(app, updateEnvironmentSecretsContract, async (c) => {
    const env = requireEnvironments(c)
    const connection = await env.connectionService.updateSecrets(
      param(c, 'workspaceId'),
      c.req.valid('json').secrets,
    )
    return c.json(connection, 200)
  })

  buildHonoRoute(app, unregisterEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    await env.connectionService.unregister(param(c, 'workspaceId'))
    return c.body(null, 204)
  })

  // What the provider needs configured (native fields or the manifest's secret keys),
  // so the UI can render a connect form generically.
  buildHonoRoute(app, describeEnvironmentProviderContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.describeProvider(param(c, 'workspaceId'), c.req.query('kind')),
      200,
    )
  })

  // Probe a candidate connection before saving (nothing persisted).
  buildHonoRoute(app, testEnvironmentConnectionContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.testConnection(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // Validate that a target repo satisfies the provider's config expectations (e.g. a
  // provider's `.deploy.yml` is present + well-formed). Nothing persisted.
  buildHonoRoute(app, validateEnvironmentRepoContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.validateRepo(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // Mechanically bootstrap (and optionally agent-repair) the provider's config file
  // in a target repo from UI-collected variables.
  buildHonoRoute(app, bootstrapEnvironmentRepoContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.bootstrapRepo(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  // Auto-detect a non-binding recommended provisioning config from a service's repo (read
  // checkout-free over RepoFiles). Nothing persisted — the SPA prefills the confirm form.
  buildHonoRoute(app, detectServiceProvisioningContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.detectServiceProvisioning(
        param(c, 'workspaceId'),
        c.req.valid('json'),
      ),
      200,
    )
  })

  // Auto-detect a non-binding recommended frontend config from a frontend repo (read checkout-free
  // over RepoFiles). Nothing persisted — the SPA prefills a preview the user applies.
  buildHonoRoute(app, detectFrontendConfigContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.detectFrontendConfig(
        param(c, 'workspaceId'),
        c.req.valid('json'),
      ),
      200,
    )
  })

  // Generate (or fix) a service's custom manifest via the fixer coding agent — dispatches a
  // durable env-config-repair run tracked exactly like the provider-config repair fallback.
  buildHonoRoute(app, repairCustomManifestContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.repairCustomManifest(
        param(c, 'workspaceId'),
        c.req.valid('json'),
      ),
      200,
    )
  })

  // ---- per-type infra handlers (the workspace "how") + custom-type catalog ----

  // The batched bundle the infra configurator loads: every registered handler + the
  // custom-manifest-type catalog (registered code types merged with workspace rows).
  buildHonoRoute(app, listEnvironmentHandlersContract, async (c) => {
    const env = requireEnvironments(c)
    const ws = param(c, 'workspaceId')
    const [handlers, customTypes] = await Promise.all([
      env.connectionService.listHandlers(ws),
      env.connectionService.listCustomTypes(ws),
    ])
    return c.json({ handlers, customTypes }, 200)
  })

  buildHonoRoute(app, registerEnvironmentHandlerContract, async (c) => {
    const env = requireEnvironments(c)
    const body = c.req.valid('json')
    const view = await env.connectionService.registerHandler(param(c, 'workspaceId'), body)
    return c.json(view, 201)
  })

  // Probe a candidate per-type handler connection before saving (nothing persisted) — e.g.
  // the Kubernetes engine form's "Test connection" reaches the apiserver with the supplied token.
  buildHonoRoute(app, testEnvironmentHandlerContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(
      await env.connectionService.testHandler(param(c, 'workspaceId'), c.req.valid('json')),
      200,
    )
  })

  buildHonoRoute(app, updateEnvironmentHandlerSecretsContract, async (c) => {
    const env = requireEnvironments(c)
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
    const type = await env.connectionService.upsertCustomType(
      param(c, 'workspaceId'),
      c.req.valid('param').manifestId,
      c.req.valid('json'),
    )
    return c.json(type, 200)
  })

  buildHonoRoute(app, removeCustomManifestTypeContract, async (c) => {
    const env = requireEnvironments(c)
    await env.connectionService.removeCustomType(
      param(c, 'workspaceId'),
      c.req.valid('param').manifestId,
    )
    return c.body(null, 204)
  })

  // The environment REGISTRY + the ephemeral-environment self-test routes, registered by a
  // sibling so this controller stays within the per-function line budget. Same `app`, so the
  // permission middleware above still covers them.
  registerEnvironmentRegistryRoutes(app)

  return app
}

/**
 * The environment REGISTRY reads/writes plus the ephemeral-environment self-test diagnostic.
 * Split out of {@link environmentController} purely for size; it registers onto the SAME app
 * instance, so the workspace-permission middleware mounted there still applies.
 */
function registerEnvironmentRegistryRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, listEnvironmentsContract, async (c) => {
    const env = requireEnvironments(c)
    return c.json(await env.provisioningService.listHandles(param(c, 'workspaceId')), 200)
  })

  buildHonoRoute(app, getEnvironmentContract, async (c) => {
    const env = requireEnvironments(c)
    const handle = await env.provisioningService.getHandle(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return handle ? c.json(handle, 200) : notFound(c)
  })

  // The only endpoint that returns decrypted access credentials (over TLS).
  buildHonoRoute(app, getEnvironmentAccessContract, async (c) => {
    const env = requireEnvironments(c)
    const handle = await env.provisioningService.getHandleWithAccess(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return handle ? c.json(handle, 200) : notFound(c)
  })

  buildHonoRoute(app, provisionEnvironmentContract, async (c) => {
    const env = requireEnvironments(c)
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
    // The confirmation rides the returned result too, but this endpoint answers with the handle
    // its contract declares; an operator reads what the probe found in the provisioning log
    // drawer, which the `teardown-verify` row lands in.
    const { handle } = await env.teardownService.teardown(
      param(c, 'workspaceId'),
      c.req.valid('param').environmentId,
    )
    return c.json(handle, 200)
  })

  // ---- ephemeral-environment self-test (diagnostic) -----------------------

  // Start a full create-branch → provision → teardown → delete-branch cycle against a
  // service frame's provisioning config. Returns immediately with the `running` run; the
  // durable driver advances it and pushes live `envTest` stage events.
  // `mode` is optional, so the historical body-less start must keep working: the route was
  // body-less for its whole life, and `buildHonoRoute`'s validator reads `c.req.json()` FIRST,
  // which throws on an absent body before the all-optional schema is ever consulted.
  app.use('/blocks/:blockId/environment-test', optionalJsonBody)
  buildHonoRoute(app, startEnvironmentTestContract, async (c) => {
    const service = requireEnvironmentTest(c)
    const workspaceId = param(c, 'workspaceId')
    const blockId = c.req.valid('param').blockId
    // Absent ⇒ the provisioning self-test, so an older client's body-less start is unchanged.
    // A deployment with no prober refuses `agent-probe` in the service, before side effects.
    const mode = c.req.valid('json').mode ?? 'provision'
    // An AGENT DRY RUN spends a model call, so it answers to the same personal-credential gate a
    // run does: a dry run whose model resolves to an individual-usage subscription (Claude) may
    // only be started by its owner, with their unlock password on the request. Without this the
    // dispatch reached the lease with no activation minted and the developer was never asked for
    // anything, which is how a workspace on the Claude preset had its prober silently dispatched
    // at the deployment's env-routing default instead. Gated on the kind the DISPATCH will resolve
    // its model under (`probeAgentKind`), not a guess. `provision` mode runs no agent and so needs
    // no credential, which is what keeps the historical body-less start ungated.
    const initiatedBy = c.get('user')?.id ?? null
    const run = await service.startTest(
      workspaceId,
      blockId,
      initiatedBy,
      mode,
      mode === 'agent-probe' ? gateAgentProbe(c, service, workspaceId, blockId) : undefined,
    )
    return c.json(run, 201)
  })

  buildHonoRoute(app, getEnvironmentTestContract, async (c) => {
    const service = requireEnvironmentTest(c)
    const run = await service.getRun(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.json(run, 200)
  })

  buildHonoRoute(app, stopEnvironmentTestContract, async (c) => {
    const service = requireEnvironmentTest(c)
    const run = await service.stop(param(c, 'workspaceId'), c.req.valid('param').id)
    return c.json(run, 200)
  })
}
