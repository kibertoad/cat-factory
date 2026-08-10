import {
  connectPublicEnvironmentContract,
  getPublicRepoBootstrapContract,
  getPublicVcsConnectionContract,
  listPublicMergePresetsContract,
  listPublicModelPresetsContract,
  listPublicWiredModelsContract,
  startPublicRepoBootstrapContract,
  testPublicEnvironmentConnectionContract,
  updatePublicServiceContract,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  type BootstrapJob,
  type EnvironmentHandlerView,
  type GitHubConnection,
  type InfraHandlerConfig,
  type KubernetesManifestSource,
  type KubernetesUrlSource,
  type ModelCatalog,
  type ModelPreset,
  type PublicBootstrapJob,
  type PublicEnvironmentConnection,
  type PublicEnvironmentConnectionView,
  type PublicKubernetesManifestSource,
  type PublicKubernetesUrlSource,
  type PublicMergePreset,
  type PublicModelPreset,
  type PublicServiceProvisioning,
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
  ModelPresetsModule,
  RiskPoliciesModule,
} from '@cat-factory/orchestration'
import { NotFoundError, UnavailableError } from '@cat-factory/kernel'
import { buildHonoRoute } from '@toad-contracts/hono'
import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AppEnv, ServerContainer } from '../../http/env.js'
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

/**
 * The workspace's source-control connection, whichever seam holds it, or the 503 when this
 * deployment wires no source control at all.
 *
 * Two seams and not one, because a GitLab-only deployment builds no `github` module: that module
 * requires the App's webhook verifier, which is App-specific (a GitLab workspace ingests through
 * the neutral `/vcs/:provider/webhooks` route instead), so it is absent exactly when the PAT
 * connect service is the thing holding the connection. Reading only the module answered a
 * provider-neutral question with "source control is not configured" at a workspace that plainly
 * had a connection, and the acceptance preflight then reported an unknown probe failure for a row
 * it could read.
 *
 * The module is preferred when present, because with BOTH wired it is the one that routes an
 * installation to its provider's client; the PAT service is the fallback, not a second opinion.
 */
export async function readVcsConnection(
  container: ServerContainer,
  workspaceId: string,
): Promise<GitHubConnection | null> {
  const github: GitHubModule | undefined = container.github
  if (github) return github.installationService.getConnection(workspaceId)
  const pat = requireCapability(
    container.vcsConnectionService,
    'Source-control integration is not configured',
  )
  return pat.getConnection(workspaceId)
}

/**
 * Whether this deployment serves per-user locally-run model endpoints.
 *
 * A named predicate over a TYPED container rather than an `!== undefined` in the route, because
 * this is the one optional-capability read on this surface whose answer is DATA rather than a
 * refusal: it is reported to the caller, so it has to be as legible as the `require*` accessors
 * next to it, and the field it names has to fail to compile if it is ever renamed.
 */
function servesUserScopedModels(container: ServerContainer): boolean {
  return container.localModelEndpoints !== undefined
}

/** The merge-preset module, or the 503. */
function requireMergePresets<E extends AppEnv>(c: Context<E>): RiskPoliciesModule {
  return requireCapability(c.get('container').riskPolicies, 'Merge presets are not configured')
}

/** The model-preset module, or the 503. */
function requireModelPresets<E extends AppEnv>(c: Context<E>): ModelPresetsModule {
  return requireCapability(c.get('container').modelPresets, 'Model presets are not configured')
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
    // The service raises that 404 itself, carrying `bootstrap_job_not_found`; a local `if (!job)`
    // beside it would be dead code, and the reason a caller branches on would ship from nowhere.
    return c.json(
      toPublicBootstrapJob(await bootstrap.service.getJob(auth.workspaceId, jobId)),
      200,
    )
  })
}

// ---- the environment connection (the ENGINE half) ---------------------------

/**
 * Lower a public URL source onto the internal one.
 *
 * Rebuilt member by member rather than passed through, because the two are separate types by
 * design (see the contracts header): the internal variant is free to gain a source or rename a
 * field, and this switch is where that stops being a silent public change. The `never` default is
 * what makes it stop at COMPILE time.
 */
function toKubernetesUrlSource(url: PublicKubernetesUrlSource): KubernetesUrlSource {
  switch (url.source) {
    case 'ingressTemplate':
      return { source: 'ingressTemplate', hostTemplate: url.hostTemplate, ...scheme(url.scheme) }
    case 'ingressStatus':
      return {
        source: 'ingressStatus',
        ...(url.ingressName === undefined ? {} : { ingressName: url.ingressName }),
        ...scheme(url.scheme),
      }
    case 'serviceStatus':
      return {
        source: 'serviceStatus',
        serviceName: url.serviceName,
        ...(url.port === undefined ? {} : { port: url.port }),
        ...scheme(url.scheme),
      }
    case 'gatewayStatus':
      return {
        source: 'gatewayStatus',
        ...(url.gatewayName === undefined ? {} : { gatewayName: url.gatewayName }),
        ...scheme(url.scheme),
      }
    case 'httpRouteStatus':
      return {
        source: 'httpRouteStatus',
        ...(url.httpRouteName === undefined ? {} : { httpRouteName: url.httpRouteName }),
        ...scheme(url.scheme),
      }
    default:
      return unreachableSource(url)
  }
}

/** An omitted `scheme` stays omitted, so the engine's own default decides rather than this mapper. */
function scheme(value: 'http' | 'https' | undefined): { scheme?: 'http' | 'https' } {
  return value === undefined ? {} : { scheme: value }
}

/** The compile-time half of the projection: a new public member has to be lowered explicitly. */
function unreachableSource(value: never): never {
  throw new Error(`unmapped public Kubernetes URL source: ${JSON.stringify(value)}`)
}

/**
 * Lower a public manifest source onto the internal one, for the same reason and with the same
 * exhaustiveness as the URL source above.
 */
export function toKubernetesManifestSource(
  source: PublicKubernetesManifestSource,
): KubernetesManifestSource {
  const renderer = source.renderer === undefined ? {} : { renderer: source.renderer }
  return source.type === 'colocated'
    ? { type: 'colocated', path: source.path, ...renderer }
    : {
        type: 'separate',
        repo: source.repo,
        ...(source.ref === undefined ? {} : { ref: source.ref }),
        path: source.path,
        ...renderer,
      }
}

/** Lower a public connection onto the internal per-engine handler config. */
function toInfraHandlerConfig(connection: PublicEnvironmentConnection): InfraHandlerConfig {
  return {
    engine: KUBERNETES_ENGINE,
    kubernetes: { ...connection.kubernetes, url: toKubernetesUrlSource(connection.kubernetes.url) },
  }
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
      toBlockPatch(c.req.valid('json'), service.provisioning),
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
export function toBlockPatch(
  input: UpdatePublicServiceInput,
  stored: ServiceProvisioning | undefined,
): {
  title?: string
  description?: string
  provisioning?: ServiceProvisioning
} {
  return {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.provisioning === undefined
      ? {}
      : { provisioning: mergeProvisioning(input.provisioning, stored) }),
  }
}

/**
 * Overlay a public provisioning patch onto what the service already declares.
 *
 * `provisioning` is ONE JSON column and `updateBlock` REPLACES it wholesale, where this surface
 * publishes two of its dozen fields. Writing just the pair would therefore delete every field the
 * public shape cannot express: a Kubernetes service's `images`, `secretInjections` and
 * `helmReleases`, authored in the app by someone who is not the caller. The next deploy would
 * render manifests with no image overrides and no Secrets, which is the "empty environment that
 * looks like a cluster fault" failure one field deeper, and the caller that caused it was only
 * correcting a manifest path.
 *
 * A patch that CHANGES the provision type replaces instead of overlaying: the stored remainder
 * belongs to the type being left behind, so carrying it forward would attach one engine's
 * configuration to another.
 */
function mergeProvisioning(
  patch: PublicServiceProvisioning,
  stored: ServiceProvisioning | undefined,
): ServiceProvisioning {
  const base = stored?.type === patch.type ? stored : undefined
  return {
    ...base,
    type: patch.type,
    manifestSource: toKubernetesManifestSource(patch.manifestSource),
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

/**
 * A model preset as this surface serves it.
 *
 * `version` and `providerPreference` stay off. The first is the SPA's reseed prompt, which is a
 * question about a library the operator maintains rather than about a run. The second names the
 * ROUTE order a resolution walks (direct, Bedrock, OpenRouter, …), and publishing it would put a
 * caller in the position of reading a preference whose members it cannot act on: nothing on this
 * surface picks a route, and the vocabulary is closed-but-persisted, so a retired member reaching a
 * public response is a shape this projection would then owe an answer for.
 */
function toPublicModelPreset(preset: ModelPreset): PublicModelPreset {
  return {
    presetId: preset.id,
    name: preset.name,
    isDefault: preset.isDefault,
    baseModelId: preset.baseModelId,
    overrides: { ...preset.overrides },
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
    // The roles the allowlist SCOPES, not the classes it allows: a role with an entry may land only
    // what that entry names (an EMPTY entry lands nothing, which is a restriction and not an
    // absence), and the class vocabulary itself stays internal.
    submissionRestrictedRoles: Object.entries(preset.submissionClassesByRole)
      .filter(([, classes]) => classes !== undefined)
      .map(([role]) => role as PublicMergePreset['submissionRestrictedRoles'][number]),
  }
}

function registerWiringRoutes(app: Hono<AppEnv>): void {
  // No user id is passed, and that absence is load-bearing rather than an omission: locally-run
  // models are one developer's own endpoints, and a key-authenticated call has no developer. See
  // `resolveWorkspaceModelCatalog`.
  //
  // Which is exactly why the omission is REPORTED. Those endpoints do not appear in this catalog at
  // all, so on a deployment whose only wired models are local ones the answer is a list where
  // nothing is available, which reads as "add a provider key" and would send an operator to change
  // a setting that is already correct. The flag says whether this deployment has that capability
  // wired at all, which is the most a key-authenticated read can honestly know.
  buildHonoRoute(app, listPublicWiredModelsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicWiredModelsContract.minScope)
    const container = c.get('container')
    const catalog = await resolveWorkspaceModelCatalog(container, auth.workspaceId)
    return c.json(
      {
        models: catalog.map(toPublicWiredModel),
        excludesUserScopedModels: servesUserScopedModels(container),
      },
      200,
    )
  })

  buildHonoRoute(app, getPublicVcsConnectionContract, async (c) => {
    const auth = await authorizeOrThrow(c, getPublicVcsConnectionContract.minScope)
    const connection = await readVcsConnection(c.get('container'), auth.workspaceId)
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

  buildHonoRoute(app, listPublicModelPresetsContract, async (c) => {
    const auth = await authorizeOrThrow(c, listPublicModelPresetsContract.minScope)
    const presets = requireModelPresets(c)
    const rows = await presets.service.list(auth.workspaceId)
    return c.json({ presets: rows.map(toPublicModelPreset) }, 200)
  })
}
