import {
  connectPublicEnvironmentContract,
  getPublicRepoBootstrapContract,
  getPublicVcsConnectionContract,
  listPublicMergePresetsContract,
  listPublicWiredModelsContract,
  startPublicRepoBootstrapContract,
  testPublicEnvironmentConnectionContract,
  updatePublicServiceContract,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  type BootstrapJob,
  type EnvironmentHandlerView,
  type GitHubConnection,
  type InfraHandlerConfig,
  type ModelCatalog,
  type PublicBootstrapJob,
  type PublicEnvironmentConnection,
  type PublicEnvironmentConnectionView,
  type PublicMergePreset,
  type PublicVcsConnection,
  type PublicWiredModel,
  type RiskPolicy,
  type ServiceProvisioning,
  type UpdatePublicServiceInput,
} from '@cat-factory/contracts'
import type {
  BootstrapModule,
  EnvironmentsModule,
  GitHubModule,
  RiskPoliciesModule,
} from '@cat-factory/orchestration'
import { NotFoundError, UnavailableError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv } from '../../http/env.js'
import { requireCapability } from '../../http/guards.js'
import { resolveWorkspaceModelCatalog } from '../models/workspaceCatalog.js'
import { toPublicService } from './boardProjection.js'
import { authorizeOrThrow } from './publicApiAuth.js'

// DEPLOYMENT PROVISIONING on `/api/v1`: bringing a workspace from "connected" to "able to run a
// pipeline". Until this existed the first four steps of automating a deployment had no public
// counterpart at all, so a caller that could provision its own keys, enrol its own webhook and file
// its own work still had to open a browser to have a repository to file it against.
//
// Its own controller rather than more of `PublicBoardController`: that file is about the shape of a
// board an integration drives, where everything here happens BEFORE there is a board to shape, and
// it is the only place on this surface that accepts an infrastructure credential.
//
// Five rules, each enforced below rather than merely intended:
//
//  1. **Every call delegates to the SAME service method the SPA's own controller calls.** A guard
//     (the bootstrap preflight that refuses a non-empty repository, the monorepo subdirectory rules,
//     the engine's own apiserver probe) cannot differ by which door the request came through.
//  2. **Public shapes are PROJECTIONS both ways.** The internal shapes these map to are internal
//     wire shapes, which this repo evolves without migrations; `/api/v1` is frozen. The mappers
//     here are the seam that lets both of those stay true, so an internal field rename is a diff in
//     this file rather than a silent public break. See `contracts/src/public-provisioning.ts`.
//  3. **A secret goes IN and never comes back.** The two connection calls accept a secret bundle
//     because reaching an apiserver needs one; every response projects the KEYS and no value.
//  4. **Refusals THROW `DomainError`s**, so `handleError` produces the one wire envelope and a
//     caller gets the `details.reason` it branches on. `authorizeOrThrow` is the auth-gate form of
//     the same rule.
//  5. **A read that cannot be answered is a 503 naming what is unwired**, never an empty success. A
//     caller reading "no models" and "models not configured" the same way is exactly the confusion
//     these reads exist to remove.

/** The bootstrap module, or the 503 naming what this deployment has not wired. */
function requireBootstrap<E extends AppEnv>(c: Context<E>): BootstrapModule {
  return requireCapability(c.get('container').bootstrap, 'Repo bootstrap is not configured')
}

/** The environments module, or the 503 naming what this deployment has not wired. */
function requireEnvironments<E extends AppEnv>(c: Context<E>): EnvironmentsModule {
  return requireCapability(
    c.get('container').environments,
    'Environment integration is not configured',
  )
}

/** The source-control module, or the 503. Provider-routing, so a GitLab workspace answers here too. */
function requireVcs<E extends AppEnv>(c: Context<E>): GitHubModule {
  return requireCapability(
    c.get('container').github,
    'Source-control integration is not configured',
  )
}

/** The merge-preset module, or the 503. */
function requireMergePresets<E extends AppEnv>(c: Context<E>): RiskPoliciesModule {
  return requireCapability(c.get('container').riskPolicies, 'Merge presets are not configured')
}

/**
 * The internal engine a public `kubernetes` connection registers as.
 *
 * The internal vocabulary splits Kubernetes in two (`local-k3s` and `remote-kubernetes`), and that
 * split is deliberately NOT a public fact: one backend serves both (`kubernetes-environment-backend`
 * declares `engines: () => ['local-k3s', 'remote-kubernetes']`), both lower to the same provision
 * type and the same provision config, so which name a handler is stored under is not observable in
 * anything a run does. Exposing the choice would be asking a caller to make a decision that changes
 * nothing, and freezing it onto a surface that can never drop it.
 */
const KUBERNETES_ENGINE = 'remote-kubernetes' as const

export function publicProvisioningController(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()
  registerBootstrapRoutes(app)
  registerEnvironmentRoutes(app)
  registerServiceRoutes(app)
  registerWiringRoutes(app)
  return app
}

// ---- repo bootstrap ---------------------------------------------------------

/**
 * Project a bootstrap run onto the wire.
 *
 * `blockId` becomes `serviceId` because that is what this surface calls a service frame everywhere
 * else, and a caller joins it straight onto `/api/v1/services/:serviceId/tasks`.
 *
 * The structured failure is FLATTENED into its three human-readable parts rather than published as a
 * nested object: the kind (whether a retry could help), the detail, and the hint. All three are
 * prose the platform wrote for whoever is reading a failed run; what is left behind is the
 * remainder whose shape is genuinely internal. See the schema for the full accounting.
 */
export function toPublicBootstrapJob(job: BootstrapJob): PublicBootstrapJob {
  return {
    jobId: job.id,
    status: job.status,
    repoName: job.repoName,
    repoOwner: job.repoOwner,
    repoUrl: job.repoUrl,
    serviceId: job.blockId,
    progress: job.subtasks,
    error: job.error,
    failureKind: job.failure?.kind ?? null,
    failureDetail: job.failure?.detail ?? null,
    failureHint: job.failure?.hint ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

function registerBootstrapRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, startPublicRepoBootstrapContract, async (c) => {
    const auth = await authorizeOrThrow(c, startPublicRepoBootstrapContract.minScope)
    const bootstrap = requireBootstrap(c)
    // Wired but unable to act is a PREDICATE, not an absent value, so it throws directly rather
    // than through the capability accessor: the same refusal the SPA's own route raises.
    if (!bootstrap.service.canBootstrap) {
      throw new UnavailableError(
        'Repo bootstrapping needs the source-control connection and the implementation container ' +
          'to be configured',
        'bootstrap_not_dispatchable',
      )
    }
    const body = c.req.valid('json')
    // The omitted-value rules live here rather than as valibot defaults on the request schema: a
    // schema default is ambiguous for a generator emitting a request type and a response type from
    // one shape, so the contract states each default in prose and this is where it is applied.
    const job = await bootstrap.service.bootstrap(auth.workspaceId, {
      repoName: body.repoName,
      ...(body.type ? { type: body.type } : {}),
      description: body.description ?? '',
      // Private unless the caller says otherwise: the safe default for a repository this creates on
      // someone's account, and the one the SPA's own form offers.
      private: body.private ?? true,
      instructions: body.instructions ?? '',
      // Omitted means "scaffold from the brief alone", which the internal input spells as an
      // explicit null rather than an absent key.
      referenceArchitectureId: body.referenceArchitectureId ?? null,
    })
    return c.json(toPublicBootstrapJob(job), 201)
  })

  buildHonoRoute(app, getPublicRepoBootstrapContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicRepoBootstrapContract.minScope)
    const bootstrap = requireBootstrap(c)
    const { jobId } = c.req.valid('param')
    // Scoped to the key's own workspace by the service, so another workspace's job is absent here
    // rather than forbidden: the same 404-hides-everything rule the rest of this surface follows.
    const job = await bootstrap.service.getJob(auth.workspaceId, jobId)
    if (!job) throw new NotFoundError('Bootstrap job', jobId, { reason: 'bootstrap_job_not_found' })
    return c.json(toPublicBootstrapJob(job), 200)
  })
}

// ---- the environment connection (the ENGINE half) ---------------------------

/** Lower a public connection onto the internal per-engine handler config. */
function toInfraHandlerConfig(connection: PublicEnvironmentConnection): InfraHandlerConfig {
  return { engine: KUBERNETES_ENGINE, kubernetes: connection.kubernetes }
}

/**
 * Project a registered handler back, with its secret KEYS and none of their values.
 *
 * `baseUrl` is the connection's own endpoint, which for a Kubernetes engine is the apiserver, so it
 * is reported under the name the caller supplied it as rather than the engine's generic one.
 */
function toPublicConnectionView(view: EnvironmentHandlerView): PublicEnvironmentConnectionView {
  return {
    provisionType: view.provisionType,
    engine: 'kubernetes',
    label: view.label,
    apiServerUrl: view.baseUrl,
    secretKeys: view.secretKeys,
  }
}

function registerEnvironmentRoutes(app: Hono<AppEnv>): void {
  // Probe without persisting. `ok: false` is an ANSWER (the cluster refused the token), so it is a
  // 200 carrying the verdict rather than an error: a caller distinguishes "the cluster said no"
  // from "the request was malformed", and only one of those is a 4xx.
  buildHonoRoute(app, testPublicEnvironmentConnectionContract, async (c) => {
    const auth = await authorizeOrThrow(c, testPublicEnvironmentConnectionContract.minScope)
    const environments = requireEnvironments(c)
    const { connection, secrets } = c.req.valid('json')
    const result = await environments.connectionService.testHandler(auth.workspaceId, {
      config: toInfraHandlerConfig(connection),
      // An omitted bundle is an EMPTY one, not an absent argument: probing a cluster with no
      // credential is a legitimate question (does it accept anonymous reads), and the engine's own
      // probe is what answers it.
      secrets: secrets ?? {},
    })
    return c.json({ ok: result.ok, message: result.message ?? null }, 200)
  })

  buildHonoRoute(app, connectPublicEnvironmentContract, async (c) => {
    const auth = await authorizeOrThrow(c, connectPublicEnvironmentContract.minScope)
    const environments = requireEnvironments(c)
    const { connection, secrets } = c.req.valid('json')
    const view = await environments.connectionService.registerHandler(auth.workspaceId, {
      // Derived rather than accepted: for a Kubernetes engine the provision type it serves is a
      // fact about the engine, so asking a caller to restate it only creates a pair that can
      // disagree.
      provisionType: 'kubernetes',
      config: toInfraHandlerConfig(connection),
      secrets,
    })
    return c.json(toPublicConnectionView(view), 201)
  })
}

// ---- a service's provisioning (the SOURCE half) -----------------------------

function registerServiceRoutes(app: Hono<AppEnv>): void {
  buildHonoRoute(app, updatePublicServiceContract, async (c) => {
    const auth = await authorizeOrThrow(c, updatePublicServiceContract.minScope)
    const container = c.get('container')
    const { serviceId } = c.req.valid('param')
    // Resolved through the public board read, so a frame in another workspace, a task id, or a
    // headless run anchor is ABSENT rather than forbidden, exactly as every other read here.
    const service = await container.boardService.getService(auth.workspaceId, serviceId)
    if (!service) throw new NotFoundError('Service', serviceId, { reason: 'service_not_found' })
    const block = await container.boardService.updateBlock(
      auth.workspaceId,
      serviceId,
      toBlockPatch(c.req.valid('json')),
      // Unattributed by the same reading a headless start gets (ADR 0037): an API key holds
      // scopes, not a workspace tier.
      UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
    )
    return c.json(toPublicService(block), 200)
  })
}

/**
 * Lower a public service patch onto the board patch.
 *
 * An omitted key is left OUT rather than written as `undefined`: `updateBlock` patches only the
 * keys present, so spreading an absent `provisioning` through would clear the stored one and
 * silently un-deploy a service whose title was being corrected.
 */
export function toBlockPatch(input: UpdatePublicServiceInput): {
  title?: string
  description?: string
  provisioning?: ServiceProvisioning
} {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.provisioning === undefined
      ? {}
      : {
          provisioning: {
            type: input.provisioning.type,
            manifestSource: input.provisioning.manifestSource,
          },
        }),
  }
}

// ---- what this deployment has WIRED -----------------------------------------

/**
 * Project one catalog model onto the two flags that decide whether a run can dispatch.
 *
 * Both are optional internally (an older catalog omitted them) and REQUIRED here, defaulted at this
 * one seam. That is the honest direction: a caller cannot branch on a field it may not receive, and
 * "absent" for either of these means the same thing as false (not selectable; not policy-blocked).
 */
function toPublicWiredModel(model: ModelCatalog[number]): PublicWiredModel {
  return {
    modelId: model.id,
    label: model.label,
    provider: model.providerLabel,
    available: model.available === true,
    policyBlocked: model.policyBlocked === true,
  }
}

/**
 * Project the workspace's VCS connection onto what it may DO.
 *
 * `provider` defaults to `github` for a row written before the column existed, which is how the
 * platform reads it everywhere else; stating it here keeps the public field non-null so a caller
 * never has to encode that fallback itself.
 */
function toPublicVcsConnection(connection: GitHubConnection): PublicVcsConnection {
  return {
    provider: connection.provider ?? 'github',
    accountLogin: connection.accountLogin,
    method: connection.method,
    canCreateRepos: connection.canCreateRepos === true,
    canManageWorkflows: connection.canManageWorkflows === true,
  }
}

function toPublicMergePreset(preset: RiskPolicy): PublicMergePreset {
  return {
    presetId: preset.id,
    name: preset.name,
    isDefault: preset.isDefault,
    autoMergeEnabled: preset.autoMergeEnabled,
    ciMaxAttempts: preset.ciMaxAttempts,
    dryRunRoles: [...preset.dryRunRoles],
  }
}

function registerWiringRoutes(app: Hono<AppEnv>): void {
  // No user id is passed, and that absence is load-bearing rather than an omission: locally-run
  // models are one developer's own endpoints, and a key-authenticated call has no developer. See
  // `resolveWorkspaceModelCatalog`.
  buildHonoRoute(app, listPublicWiredModelsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicWiredModelsContract.minScope)
    const catalog = await resolveWorkspaceModelCatalog(c.get('container'), auth.workspaceId)
    return c.json({ models: catalog.map(toPublicWiredModel) }, 200)
  })

  buildHonoRoute(app, getPublicVcsConnectionContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicVcsConnectionContract.minScope)
    const vcs = requireVcs(c)
    const connection = await vcs.installationService.getConnection(auth.workspaceId)
    // Null is an ANSWER ("nothing connected"), which is the state a caller setting a workspace up
    // is most likely to be in, so it is a 200 carrying null rather than a 404.
    return c.json({ connection: connection ? toPublicVcsConnection(connection) : null }, 200)
  })

  buildHonoRoute(app, listPublicMergePresetsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicMergePresetsContract.minScope)
    const presets = requireMergePresets(c)
    const rows = await presets.service.list(auth.workspaceId)
    return c.json({ presets: rows.map(toPublicMergePreset) }, 200)
  })
}
