// Opt-in AWS EKS backends (runner + environment), registered by reference below (the Worker
// facade registers the same pair, keeping the runtimes symmetric with the native `kubernetes`
// backend these extend). They are pass-throughs until a workspace actually connects an `eks`
// backend, and carry NO runtime AWS SDK dependency (the token is minted with WebCrypto), so this
// adds no cost to a deployment that never uses EKS.
import { type NotificationWebhookService } from '@cat-factory/integrations'
import {
  type GitHubInstallationRepository,
  type InlineLlmCallRecorder,
  type PlatformAlertSink,
  type SubscriptionVendor,
  type ToolSecretResolver,
} from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ServerContainer,
  ContainerSessionService,
  GitHubIdentityResolver,
  bedrockAllowListFromEnv,
  testEnvHasZeroConfigDefault,
  buildResolveRepoTarget,
  makePreviewJobBuilder,
  type PersistenceRegistry,
  logger,
  mcpAuthServerContainerFields,
  mcpOAuthContainerFields,
  resolveUrlSafetyPolicy,
  WebCryptoSecretCipher,
} from '@cat-factory/server'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`
// below, then wires each gate's provider.
import { applyGateProviders, warnUnwiredGates } from '@cat-factory/gates'
import { GitLabIdentityResolver } from '@cat-factory/gitlab'
import type {
  AgentContextRecorder,
  ResolveBinaryArtifactStore,
  ResolveRunInitiatorToken,
  VcsIdentityRegistry,
} from '@cat-factory/kernel'
import type { ListWorkspaceRunRepos } from '@cat-factory/server'

import { selectNodeGitHubDeps } from './container-github-deps.js'
import { buildNodeModelDeps } from './container-model-deps.js'
import { buildNodeRunServices } from './container-run-services-deps.js'
import { buildNodeAppRegistry, buildNodeRunPlatform } from './container-run-platform.js'
import { buildNodeBootstrapper, buildNodeTransportDeploy } from './container-transport-deps.js'
import { buildNodeAccountDeps } from './container-account-deps.js'
import { buildNodeRealtimeDeps } from './container-realtime-deps.js'
import type { DrizzleDb } from './db/client.js'
import { createNodeGateways } from './gateways.js'
import { baseUrlForNode } from './providerEndpoints.js'
import { LocalMachineEventRelay } from './machineEventRelay.js'
import { makeNodeClientAddressResolver } from './clientAddress.js'

import { DrizzleRepoProjectionRepository } from './repositories/github.js'
import { DrizzleUserRepoAccessRepository } from './repositories/userRepoAccess.js'
import { DrizzleSealedSecretInventory } from './repositories/drizzle/sealedSecretInventory.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'

// The container-agent-executor wiring (transport resolver, provisioning-log wrapper, container
// executor + bootstrapper + env-config repairer, GitHub-issue filer, trace-sink builder), lifted
// into a sibling module so this composition root stays within the file-size budget.
import { selectNodeEnvConfigRepairer } from './container-executor-deps.js'

import { assembleNodeCoreDependencies } from './container-core-deps.js'
import {
  resolveNodeContainerFoundation,
  type NodeAppRegistriesResult,
  type NodeContainerFoundation,
} from './container-foundation.js'
// Re-exported for the mothership routing-seam test + any facade that sources its own repos.
export { pickRepoSource } from './container-foundation.js'

// Re-export the public seams the local facade + tests still import from `./container.js`.
export {
  buildNodeResolveTransport,
  missingContainerExecutorPrereqs,
  withProvisioningLog,
} from './container-executor-deps.js'

// Memoised per object so a container build shares ONE model provider (hence one inline
// trace sink) across the agent executor, requirements reviewer, doc planner and
// fragment selector, and ONE core trace sink — instead of each call constructing its
// own. Mirrors the Worker's `buildModelProvider` memoisation. Memoisation matters more for
// OTel than Langfuse: the SDK sink owns batch processors/exporters, so it must be built
// once per config, not per wiring site.

/**
 * Rate-limit accounting is best-effort telemetry the Worker persists to D1; the Node
 * facade has no such table, so it drops the snapshots (exactly like the local facade).
 */
/**
 * The hosted PAT-login registry: lets a user sign in by pasting their OWN source-control PAT,
 * which the shared `/auth/pat` flow resolves to the account it belongs to (and holds to the
 * server's login/org/domain allowlist — see `AuthController`). GitHub is always available;
 * GitLab is added when a GitLab connection is configured. Unlike local mode there is NO
 * `configuredToken` — a remote deployment is multi-user, so there's no shared one-click env
 * token; each user supplies their own PAT.
 */
function buildNodeVcsIdentityRegistry(config: AppConfig): VcsIdentityRegistry {
  const registry: VcsIdentityRegistry = {
    github: { resolver: new GitHubIdentityResolver({ apiBase: config.github.apiBase, logger }) },
  }
  if (config.gitlab.enabled) {
    registry.gitlab = {
      resolver: new GitLabIdentityResolver({ apiBase: config.gitlab.apiBase, logger }),
    }
  }
  return registry
}

/**
 * The seams `buildNodeContainer` hands to
 * {@link NodeContainerOptions.wrapModelProviderResolver}: the subscription-credential leases,
 * present only when the corresponding subscription service is configured (ENCRYPTION_KEY + a token
 * store), plus the inline metric recorder. The local facade's inline-harness wrap uses the leases
 * to lease a credential for an inline subscription call run in a warm container — the personal
 * per-run activation for an individual vendor, the pooled token otherwise — mirroring
 * `ContainerAgentExecutor.resolveAuth`.
 */
export interface ModelProviderResolverWrapDeps {
  leasePersonalSubscriptionToken?: (
    executionId: string,
    userId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
  leaseSubscriptionToken?: (
    workspaceId: string,
    vendor: SubscriptionVendor,
  ) => Promise<{ secret: string }>
  /**
   * The facade's `llm_call_metrics` recorder, for a wrap whose model SUBSTITUTION can report its
   * own per-call telemetry — local mode's inline harness, where one `generateText` is a whole CLI
   * tool loop and so the instrumentation middleware around it can only ever see one lumped call,
   * after the fact. Such a model files its own rows and stands the middleware down
   * (`reportsOwnLlmCalls` in `@cat-factory/agents`); a wrap that substitutes nothing ignores this.
   *
   * The SAME recorder the instrumentation is built with (`createInlineInstrumentation`), never a
   * second one: the service behind it owns the external trace-sink fan-out, so two instances would
   * split one run's trace.
   *
   * REQUIRED but nullable, unlike the leases above: `undefined` is the real answer for a facade
   * that retains no metrics (the middleware then keeps doing what it can), but a facade that
   * FORGOT to pass it looks identical — and the symptom would be the one this whole seam exists to
   * remove, a run reporting no model activity while it spends millions of tokens. An omitted
   * optional field fails silently; an omitted required one fails at typecheck. Same argument as
   * `InstrumentedModelProvider`'s `workspaceBodiesEnabled`.
   */
  recordInlineCall: InlineLlmCallRecorder | undefined
  /**
   * The deployment's `LLM_RECORD_PROMPTS` switch, for the same wrap.
   *
   * A harness CLI's per-call bodies are not handed to us, they are RECONSTRUCTED: the growing
   * request transcript, re-serialised at every call, retained in this process. So unlike a body that
   * merely travels as a thunk, one nobody will keep has to be refused at the SOURCE — hence a flag
   * beside the recorder rather than a gate further down.
   *
   * REQUIRED for the same reason as {@link recordInlineCall}: `false` is a real answer, an omission
   * is a wiring mistake, and only a required field tells them apart.
   */
  recordInlineBodies: boolean
}

// The composition-root options surface lives beside this builder in `container-options.ts` (a
// size-only split); re-exported here so every existing `from './container.js'` import is unchanged.
import type { NodeContainerOptions } from './container-options.js'
export type { NodeContainerOptions }

/**
 * Resolve which runner backend a workspace's container jobs dispatch to. The Node
 * facade has no built-in per-run container runtime (unlike the Worker's Cloudflare
 * Containers), so it serves a workspace's self-hosted runner pool when one is
 * registered and throws a clear error otherwise. Returns null (no transport at all)
 * when runner pools are not enabled. Mirrors the Worker's `buildResolveTransport`,
 * minus the Cloudflare-container path.
 */
/**
 * The Node composition root: assemble the framework-agnostic domain `Core` with
 * Drizzle/Postgres repositories + Node implementations of the runtime ports, then
 * attach the shared-controller extras (`config`, the kind-spanning agent-run repo,
 * the runtime gateways). The same persistence is used in dev, test and prod — tests
 * run against a real Postgres, exactly as the Worker runs against a real D1.
 *
 * Repo-operating agent steps (coder, blueprints, merger, …) run in a container
 * dispatched to a workspace's self-hosted runner pool — the shared
 * `ContainerAgentExecutor`, exactly as on the Worker. When the prerequisites (GitHub
 * App, `PUBLIC_URL`, `AUTH_SESSION_SECRET`, `ENCRYPTION_KEY`) are absent the
 * composite still serves inline kinds but fails container kinds loudly.
 */

/**
 * Wire the browsable frontend-preview module (slice 5c) onto the built dependencies. Local mode
 * injects the real transport; the conformance suite injects BOTH a fake transport + a fake job
 * builder via `overrides` (which win, so the flow runs on real Postgres without GitHub). The
 * Worker/Node-pool inject neither ⇒ the module stays absent (the controller 503s). When a
 * transport is present but no builder was injected, construct the real one from the SAME
 * repo/token/session seams the container executor uses; without those (no PUBLIC_URL / session
 * secret / token mint) the module stays unwired rather than half-built. Extracted from
 * {@link buildNodeContainer} to keep it under the statement ceiling.
 */
interface PreviewModuleContext {
  env: NodeJS.ProcessEnv
  config: AppConfig
  repos: ReturnType<typeof createDrizzleRepositories>
  resolveRepoTarget: ReturnType<typeof buildResolveRepoTarget>
  baseDeployMint: ReturnType<typeof buildNodeTransportDeploy>['baseDeployMint']
}

function wirePreviewModule(
  dependencies: CoreDependencies,
  options: NodeContainerOptions,
  ctx: PreviewModuleContext,
): void {
  const { env, config, repos, resolveRepoTarget, baseDeployMint } = ctx
  if (options.previewTransport && !dependencies.previewTransport) {
    dependencies.previewTransport = options.previewTransport
  }
  if (dependencies.previewTransport && !dependencies.buildPreviewJob) {
    const previewPublicUrl = env.PUBLIC_URL?.trim()
    const previewSessionSecret = config.auth.sessionSecret
    if (previewPublicUrl && previewSessionSecret && baseDeployMint) {
      dependencies.buildPreviewJob = makePreviewJobBuilder({
        blockRepository: repos.blockRepository,
        resolveRepoTarget,
        mintInstallationToken: baseDeployMint,
        ...(options.resolveRepoOrigin ? { resolveRepoOrigin: options.resolveRepoOrigin } : {}),
        sessionService: new ContainerSessionService({ secret: previewSessionSecret }),
        proxyBaseUrl: `${previewPublicUrl.replace(/\/+$/, '')}/v1`,
        ...(config.github.apiBase ? { githubApiBase: config.github.apiBase } : {}),
        ...(dependencies.environmentRegistryRepository
          ? { environmentRegistryRepository: dependencies.environmentRegistryRepository }
          : {}),
      })
    }
  }
}

/**
 * Mothership mode (`db` undefined): `AgentContextBuilder` reads a block's linked docs/tasks
 * (`documentRepository`/`taskRepository`.listByBlock/get) on EVERY container agent dispatch, so
 * these are on the board-load + run path even though the document/task INTEGRATIONS are opt-in.
 * The sub-helpers (`selectNodeDocumentsDeps`/`selectNodeTasksDeps`) build them directly over the
 * absent `db` and only when their integration is CONFIGURED, so the context-builder run-path repos
 * are re-sourced here instead: they are read on every dispatch whether or not a workspace ever
 * connected a source. The integrations' own connection/settings repos need no line here, because
 * those helpers source them at construction now that a connection row carries its credential bag
 * SEALED (the mothership opens it by name over `/internal/secrets/unseal`) — plus the environment
 * CONNECTION management surface below. Routing is orthogonal to the allow-list: an un-allow-listed remote method
 * returns a clean `unknown_method`, never a `db`-undefined `TypeError`. A no-op outside mothership
 * mode (`remoteRepos` undefined). Extracted from {@link buildNodeContainer} to keep it under budget.
 */
export function applyMothershipRemoteRepos(
  dependencies: CoreDependencies,
  remoteRepos: Record<string, unknown> | undefined,
): void {
  if (!remoteRepos) return
  dependencies.documentRepository =
    remoteRepos.documentRepository as CoreDependencies['documentRepository']
  dependencies.taskRepository = remoteRepos.taskRepository as CoreDependencies['taskRepository']
  // The context builder also resolves the block's live environment per step
  // (`environmentProvisioning.resolveForBlock` → `environmentRegistryRepository.getByBlock`,
  // null when no env is provisioned — the common path). Route both environment repos so the
  // service `createCore` builds reads org state remotely. The row's access cipher is sealed with
  // the mothership's key, which still never reaches this laptop: it is OPENED by the mothership
  // over `/internal/secrets/unseal`, addressed by row, through `CoreDependencies.secretDelegate`.
  // So provisioning, status polling and teardown all run here for real.
  dependencies.environmentRegistryRepository =
    remoteRepos.environmentRegistryRepository as CoreDependencies['environmentRegistryRepository']
  dependencies.environmentConnectionRepository =
    remoteRepos.environmentConnectionRepository as CoreDependencies['environmentConnectionRepository']
  // The environments management panel also reads/edits the workspace's custom-manifest-type
  // catalog (`EnvironmentConnectionService.listCustomTypes`/`upsertCustomType`), built directly
  // over the absent `db` by `selectNodeEnvironmentsDeps`. Route it from the remote registry too so
  // the connection + infra-handler management surface is functional (no secrets — just manifest
  // metadata; the RPC allow-list gates its CRUD).
  dependencies.customManifestTypeRepository =
    remoteRepos.customManifestTypeRepository as CoreDependencies['customManifestTypeRepository']
  // The prompt-fragment library (`FragmentLibraryService`, built directly over the absent `db`
  // by `selectNodeFragmentLibraryDeps`) — its management surface (list/create/update/delete
  // fragments + list/link sources) AND, since the library-sync slice, its repo-SYNC surface are
  // served remotely, so the library panels and the link/sync/unlink routes are functional in
  // mothership mode; rows carry no secrets, and the RPC allow-list gates each method by its
  // `(ownerKind, ownerId)` scope (`librarySource` for the sourceId-keyed sync methods). The node
  // reaches the guideline repos through the delegated App token, like the skills library below.
  //
  // Route only when the library is ALREADY configured (`config.fragmentLibrary.enabled` — else
  // these are absent). UNLIKE the document/task/env repos above (whose modules need extra deps,
  // so setting the repo alone leaves the module off), the fragment module assembles from
  // `promptFragmentRepository` ALONE — so unconditionally setting it would spuriously turn the
  // module ON and force fragment resolution on EVERY run against a mothership that may not wire
  // the repo. Overriding in place preserves the "module only when configured" gate while swapping
  // the (db-less, broken) Drizzle repo for the remote one.
  if (dependencies.promptFragmentRepository) {
    dependencies.promptFragmentRepository =
      remoteRepos.promptFragmentRepository as CoreDependencies['promptFragmentRepository']
  }
  if (dependencies.fragmentSourceRepository) {
    dependencies.fragmentSourceRepository =
      remoteRepos.fragmentSourceRepository as CoreDependencies['fragmentSourceRepository']
  }
  // The GENERATED brief store, built over the same absent `db` by the same helper. It is read AND
  // written on the run path (an implementer dispatch resolves a brief alongside the body it
  // condenses), so leaving it db-direct was a `TypeError` per dispatch rather than a blank panel —
  // the same class of gap the routing guard in `mothership-repo-source.spec.ts` now closes
  // structurally.
  if (dependencies.fragmentBriefRepository) {
    dependencies.fragmentBriefRepository =
      remoteRepos.fragmentBriefRepository as CoreDependencies['fragmentBriefRepository']
  }
  // The Claude Skills library, same shape as the fragment library above: swap the (db-less,
  // broken) Drizzle repos for the remote ones, keeping the "module only when configured" gate.
  //
  // UNLIKE the fragment library, the repo-SYNC surface is remote too — a mothership-mode node
  // reaches GitHub by token delegation, so its `SkillSourceService` assembles and its link /
  // sync / unlink routes are live. The sourceId-keyed methods bind through the `skillSource`
  // scope rule (see `REMOTE_PERSISTENCE_METHODS`). Routing the catalog is not cosmetic: a
  // `skill` step's `skillResolver` is a HARD dependency, so an un-routed read fails the
  // dispatch rather than blanking a panel.
  if (dependencies.accountSkillRepository) {
    dependencies.accountSkillRepository =
      remoteRepos.accountSkillRepository as CoreDependencies['accountSkillRepository']
  }
  if (dependencies.skillSourceRepository) {
    dependencies.skillSourceRepository =
      remoteRepos.skillSourceRepository as CoreDependencies['skillSourceRepository']
  }
  // The foundational-services catalog (ADR 0031), its API-contract documents and its repo sources.
  // Routed UNCONDITIONALLY, unlike the two libraries above: `selectNodeFoundationalServiceDeps` is
  // deliberately UNGATED (a service's contracts can be uploaded with no repo source at all), so
  // these three are always present and the "setting the repo would spuriously turn the module on"
  // hazard does not apply — what applies instead is that the module is always ON, over a Drizzle
  // repo built from an absent `db`. That is worse than an un-allow-listed method: it is a
  // `TypeError` on the RUN path, since an architect dispatch resolves the merged catalog and a
  // coder dispatch resolves the declared services' contracts. The allow-list has named this
  // surface remote since the catalog slice; it was reachable only from the Cloudflare facade.
  dependencies.foundationalServiceRepository =
    remoteRepos.foundationalServiceRepository as CoreDependencies['foundationalServiceRepository']
  dependencies.apiContractRepository =
    remoteRepos.apiContractRepository as CoreDependencies['apiContractRepository']
  dependencies.foundationalServiceSourceRepository =
    remoteRepos.foundationalServiceSourceRepository as CoreDependencies['foundationalServiceSourceRepository']
}

interface PostAssemblyContext extends PreviewModuleContext {
  options: NodeContainerOptions
  resolveTransport: NodeTransportDeployResult['resolveTransport']
  githubInstallationRepository: GitHubInstallationRepository
  /** Routed through `sourced`, so a mothership node reads the projection over the RPC. */
  repoProjectionRepository: DrizzleRepoProjectionRepository
  bootstrapMintInstallationToken: NodeBootstrapperResult['bootstrapMintInstallationToken']
  environmentBackendRegistry: NodeAppRegistriesResult['environmentBackendRegistry']
  remoteRepos: Record<string, unknown> | undefined
}

/**
 * The three adjustments made to the ASSEMBLED dependency object, grouped because each one can only
 * run once `assembleNodeCoreDependencies` has returned: the preview module reads the final
 * `environmentRegistryRepository`, the env-config repairer wraps the final `environmentProvider`
 * (so an injected native adapter, not the default manifest provider, is what it drives), and the
 * mothership re-sourcing replaces repos the sub-helpers built over an absent `db`.
 *
 * Extracted from {@link finalizeNodeContainer} to keep it inside its line budget; the two `apply*`
 * helpers it calls stay where they are, since they are the units the comments above them document.
 */
function applyNodePostAssemblyWiring(
  dependencies: CoreDependencies,
  ctx: PostAssemblyContext,
): void {
  const { options, env, config, repos, resolveRepoTarget, baseDeployMint } = ctx
  // Browsable frontend preview (slice 5c): wire the preview module when a per-runtime preview
  // transport is available (real in local mode / a fake pair in the conformance suite).
  wirePreviewModule(dependencies, options, {
    env,
    config,
    repos,
    resolveRepoTarget,
    baseDeployMint,
  })

  // Wire the live env-config repair agent over the FINAL environment provider (after the
  // `...options.overrides` above), so an injected native adapter — not the default manifest
  // provider — is what the repair dispatcher uses. Unwired on a stock deployment (the
  // generic provider has no `describeRepairAgent`), exactly like the service guard. Local
  // inherits this through `buildNodeContainer` with no extra wiring.
  const envConfigRepairer = selectNodeEnvConfigRepairer({
    env,
    config,
    resolveTransport: ctx.resolveTransport,
    installationRepository: ctx.githubInstallationRepository,
    repoRepository: ctx.repoProjectionRepository,
    mintInstallationToken: ctx.bootstrapMintInstallationToken,
    override: dependencies.environmentProvider,
    environmentBackendRegistry: ctx.environmentBackendRegistry,
  })
  // Don't clobber an override-provided repairer (e.g. the conformance suite's fake): an
  // explicit `overrides.envConfigRepairer` wins, exactly like `repoBootstrapper`.
  if (envConfigRepairer && !dependencies.envConfigRepairer) {
    dependencies.envConfigRepairer = envConfigRepairer
  }

  // Mothership mode (`db` undefined): re-source the run-path org/durable repos the sub-helpers
  // built directly over the absent `db` from the remote registry (a no-op outside mothership mode).
  applyMothershipRemoteRepos(dependencies, ctx.remoteRepos)
}

export type NodeModelDepsResult = ReturnType<typeof buildNodeModelDeps>
export type NodeTransportDeployResult = ReturnType<typeof buildNodeTransportDeploy>
export type NodeRunServicesResult = ReturnType<typeof buildNodeRunServices>
export type NodeGitHubDepsResult = ReturnType<typeof selectNodeGitHubDeps>
export type NodeBootstrapperResult = ReturnType<typeof buildNodeBootstrapper>
export type NodeRealtimeDepsResult = ReturnType<typeof buildNodeRealtimeDeps>
export type NodeAccountDepsResult = ReturnType<typeof buildNodeAccountDeps>

interface NodeServerContainerBundle {
  dependencies: CoreDependencies
  config: AppConfig
  /** The non-in-app delivery channels, surfaced for the mothership delivery seam (see below). */
  externalNotificationChannel: NodeRealtimeDepsResult['externalNotificationChannel']
  defaultWebSearchUpstream: NodeRunServicesResult['defaultWebSearchUpstream']
  resolveRepoTarget: ReturnType<typeof buildResolveRepoTarget>
  /** The board-wide run-target set, built beside the block resolver on the run platform. */
  listWorkspaceRunRepos: ListWorkspaceRunRepos
  repos: ReturnType<typeof createDrizzleRepositories>
  appRegistry: ReturnType<typeof buildNodeAppRegistry>
  options: NodeContainerOptions
  repoProjectionRepository: DrizzleRepoProjectionRepository
  githubInstallationRepository: GitHubInstallationRepository
  environmentBackendRegistry: NodeAppRegistriesResult['environmentBackendRegistry']
  runnerBackendRegistry: NodeAppRegistriesResult['runnerBackendRegistry']
  resolveBinaryArtifactStore: NodeAccountDepsResult['resolveBinaryArtifactStore']
  gateways: ReturnType<typeof createNodeGateways>
  vcsRegistry: NodeAppRegistriesResult['vcsRegistry']
  testSecretsService: NodeRunServicesResult['testSecretsService']
  capabilityCredentialsService: NodeRunServicesResult['capabilityCredentialsService']
  mcpOAuthService: NodeRunServicesResult['mcpOAuthService']
  /**
   * The composed capability-credential chain, as `toolSecretContainerFields` projects it: the
   * resolver the tool-server probe resolves through, plus whether this node's environment answers
   * behind the per-workspace store. The description is ABSENT (not undefined) when a deployment
   * replaced the chain with its own resolver, because the checklist renders three states off that
   * distinction.
   */
  toolSecretEnvironmentFallback?: boolean
  toolSecretResolver: ToolSecretResolver
  validationConfigService: NodeRunServicesResult['validationConfigService']
  subscriptions: NodeModelDepsResult['subscriptions']
  personalSubscriptions: NodeModelDepsResult['personalSubscriptions']
  apiKeys: NodeModelDepsResult['apiKeys']
  publicApiKeys: NodeModelDepsResult['publicApiKeys']
  /** The per-workspace outbound notification-webhook config service (null with no encryption key). */
  notificationWebhooks: NotificationWebhookService | undefined
  /**
   * The outbound platform-health push the health sweep hands its firing/resolved edges to. From
   * the SAME builder as the service above (undefined with no encryption key), so this facade
   * cannot wire the management surface and leave the alerts undelivered.
   */
  platformAlertSink: PlatformAlertSink | undefined
  cloudflareModelsEnabled: NodeModelDepsResult['cloudflareModelsEnabled']
  env: NodeJS.ProcessEnv
  localModelEndpoints: NodeModelDepsResult['localModelEndpoints']
  userSecrets: NodeModelDepsResult['userSecrets']
  db: DrizzleDb
  openRouterCatalog: NodeModelDepsResult['openRouterCatalog']
  traceSink: NodeModelDepsResult['traceSink']
}

/**
 * The repository registry the mothership-mode machine API (`POST /internal/persistence`) reflects
 * over, so a Node deployment can act as a mothership for mothership-mode local nodes.
 *
 * Extracted from the container projection when that outgrew its function budget, and it is a
 * cohesive concern rather than a convenient cut: everything here answers ONE question, which
 * repositories a machine-authed node may reach over RPC, and every entry beyond the `dependencies`
 * spread is a store that is NOT part of `CoreDependencies` and therefore has to be folded in by
 * name. The controller gates which repo+method is callable (allow-list) and account-scopes each
 * call, so exposing the whole `dependencies` object (which carries every repo under its canonical
 * name) is safe. Sourced identically on both facades so they attach the same registry surface.
 */
function buildNodePersistenceRegistry(bundle: {
  dependencies: CoreDependencies
  repos: ReturnType<typeof createDrizzleRepositories>
  repoProjectionRepository: DrizzleRepoProjectionRepository
  githubInstallationRepository: GitHubInstallationRepository
}): PersistenceRegistry {
  const { dependencies, repos, repoProjectionRepository, githubInstallationRepository } = bundle
  return {
    ...dependencies,
    agentRunRepository: repos.agentRunRepository,
    // The binary-artifact METADATA store (visual-confirmation gate screenshots/references) is
    // not part of `CoreDependencies` (it's composed into `resolveBinaryArtifactStore`, not the
    // engine's Core), so fold it into the reflected registry explicitly — else a mothership-mode
    // node's artifact reads/writes come back `... is not wired`. The blob BYTES stay per-account
    // local; only the metadata is proxied.
    binaryArtifactMetadataStore: repos.binaryArtifactMetadataStore,
    // The sensitive per-service test-credential store is org/durable state the engine reads via
    // the `resolveTestSecretRefs` FUNCTION (never the repo directly), so it isn't in
    // `CoreDependencies` either — fold it in explicitly, else a mothership-mode node's tester
    // run-path read + the inspector CRUD come back `... is not wired`. Only the SEALED blob is
    // proxied (decrypted service-side under the LOCAL key), like the observability/runner-pool
    // connections.
    testSecretsRepository: repos.testSecretsRepository,
    // GitHub projection + installation reads the mothership serves over the persistence RPC even
    // when its OWN github service is off. A mothership-mode local node reaches GitHub by token
    // DELEGATION (no local App), which enables `container.github`, so its board snapshot
    // (`github.service.listRepos` → `repoProjectionRepository.list`) and run-path repo resolution
    // (`githubInstallationRepository.getByWorkspace` + `repoProjectionRepository.list`) read the
    // projection over RPC. Both are plain org tables the mothership owns, constructed
    // unconditionally above — so reflect them regardless of `config.github.enabled` (they land in
    // `dependencies` only when the github MODULE is wired), else a mothership without its own App
    // configured 500s that board load with `... is not wired`. Allow-listed in
    // `REMOTE_PERSISTENCE_METHODS`; folded in explicitly like the stores above.
    repoProjectionRepository,
    githubInstallationRepository,
  } as unknown as PersistenceRegistry
}

/**
 * Project the assembled engine core + the Node-facade extras onto the {@link ServerContainer}
 * the HTTP layer resolves. Extracted verbatim from {@link buildNodeContainer} (a function-size
 * ratchet split — behaviour is identical); the mothership persistence-registry surface, the
 * per-user credential stores, and the VCS/gateway wiring are surfaced exactly as before.
 */
function projectNodeServerContainer(bundle: NodeServerContainerBundle): ServerContainer {
  const {
    dependencies,
    config,
    externalNotificationChannel,
    defaultWebSearchUpstream,
    resolveRepoTarget,
    listWorkspaceRunRepos,
    repos,
    appRegistry,
    options,
    repoProjectionRepository,
    githubInstallationRepository,
    environmentBackendRegistry,
    runnerBackendRegistry,
    resolveBinaryArtifactStore,
    gateways,
    vcsRegistry,
    testSecretsService,
    capabilityCredentialsService,
    mcpOAuthService,
    toolSecretEnvironmentFallback,
    toolSecretResolver,
    validationConfigService,
    subscriptions,
    personalSubscriptions,
    apiKeys,
    publicApiKeys,
    notificationWebhooks,
    platformAlertSink,
    cloudflareModelsEnabled,
    env,
    localModelEndpoints,
    userSecrets,
    db,
    openRouterCatalog,
    traceSink,
  } = bundle
  // The Bedrock allow-list that gates `bedrock`-flavour selectability. Derived from `env` here
  // (like `baseUrlFor` below) rather than threaded from the model deps: it is one
  // deployment-level env read, and the SAME parser feeds the resolver's own allow-list, so the
  // picker cannot offer a Bedrock id the resolver would throw on.
  const bedrockModels = bedrockAllowListFromEnv(env)
  return {
    ...createCore(dependencies),
    config,
    // The deployment-wide trusted web-search upstream (built from `WEB_SEARCH_*` env above),
    // read by `WebSearchProxyController` as the fallback when a run's account has no keys.
    ...(defaultWebSearchUpstream ? { defaultWebSearchUpstream } : {}),
    // The same checkout-free repo resolver the engine binds pre/post-ops with, surfaced so
    // the shared service-spec read controller can read the `spec/` artifact off main.
    resolveRunRepoContext: dependencies.resolveRunRepoContext,
    // The block→service→repo resolver, surfaced so the task-search controller can scope a
    // GitHub-issue search to the originating service's repo (and refuse it when unlinked).
    resolveRepoTarget,
    // Its board-wide sibling, surfaced so the credential check can ask whether this
    // workspace's runs reach GitHub at all before judging a stored GitHub token.
    listWorkspaceRunRepos,
    agentRunRepository: repos.agentRunRepository,
    // Execution-scoped repo, surfaced for the conformance suite's compareAndSwap parity check.
    executionRepository: repos.executionRepository,
    // Mothership-side GitHub token delegation (`POST /internal/github/installation-token`):
    // when this deployment's GitHub App is configured, a machine-authed mothership-mode node
    // can mint the short-lived installation tokens its agent containers/gates need — the App
    // private key never leaves this service. The registry satisfies the seam structurally.
    // Wired symmetrically on the Cloudflare facade.
    ...(appRegistry ? { githubTokenDelegation: appRegistry } : {}),
    // Mothership-side real-time UPSTREAM delivery (`POST /internal/events/publish`): when this
    // deployment is a mothership (its realtime transport is wired), a machine-authed mothership-mode
    // node's relayed engine events land in this deployment's OWN fan-out (`options.realtimeSink` —
    // the hub, or the layered propagator on a multi-node deployment), so hosted teammates on the
    // shared board see the local node's activity live. Wired symmetrically on the Cloudflare facade
    // (the per-workspace WorkspaceEventsHub Durable Object). Absent realtime ⇒ the endpoint 503s.
    ...(options.realtimeSink
      ? { machineEventRelay: new LocalMachineEventRelay(options.realtimeSink) }
      : {}),
    // Mothership-side notification DELIVERY (`POST /internal/notifications/deliver`): a
    // mothership-mode node persists its notification rows here but holds none of the org's
    // external delivery credentials (the Slack bot token is sealed with THIS deployment's key),
    // so it asks the mothership to deliver a row by id. Wired with the EXTERNAL channels only —
    // the in-app frame for a laptop-raised notification already arrives over the real-time
    // upstream relay, so delivering it here too would double-push it. Wired symmetrically on the
    // Cloudflare facade. No external channel (no Slack) ⇒ the endpoint 503s.
    ...(externalNotificationChannel
      ? { machineNotificationDelivery: externalNotificationChannel }
      : {}),
    repositories: buildNodePersistenceRegistry({
      dependencies,
      repos,
      repoProjectionRepository,
      githubInstallationRepository,
    }),
    // The machine-node roster + revocation tombstones (SEC-5): recorded on every machine-token
    // mint, consulted by the shared machine gate on every /internal/* call, served to the owner
    // via /auth/machine-nodes. Wired symmetrically on the Cloudflare facade.
    machineNodeRepository: repos.machineNodeRepository,
    // The durable cross-replica window behind the password throttle (SEC-4). Wired
    // symmetrically on the Cloudflare facade.
    authAttemptRepository: repos.authAttemptRepository,
    // The client address the password throttle keys on (SEC-4): the socket peer, or the
    // operator's declared `x-forwarded-for` hop. See `clientAddress.ts` for why this facade
    // never reads `cf-connecting-ip`.
    resolveClientAddress: makeNodeClientAddressResolver(config.auth),
    // App-owned backend registries, surfaced so the workspace snapshot's backend-kind
    // selectors (`environmentBackendKinds` / `runnerBackendKinds`) read the registered kinds.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The consensus transcript store, for the read endpoint (window load / reload).
    consensusSessionRepository: repos.consensusSessionRepository,
    // Resolves the per-account binary-artifact store (screenshots) for the artifact
    // controllers + the visual-confirmation gate (configured per-account in the UI).
    //
    // Read off `dependencies`, NOT the account-composed value beside it: an override supplied to
    // the container (a deployment swapping the backend, the conformance harness driving the
    // public artifact reads) is applied to the engine's deps and would otherwise reach the ENGINE
    // and not the HTTP layer, leaving two answers to "where do this workspace's artifacts live", which
    // is a split nothing above this line could see.
    resolveBinaryArtifactStore:
      dependencies.resolveBinaryArtifactStore ?? resolveBinaryArtifactStore,
    // Stock/remote Node has NO built-in container runtime, so container agents run ONLY on a
    // self-hosted runner pool — an unregistered pool means no agent can run, which the infra-setup
    // banner should surface. Local mode injects its own per-run-host-container `resolveTransport`
    // (so the pool is optional there); detect that by the absence of the default pool transport.
    agentExecutorRequiresRunnerPool: options.resolveTransport === undefined,
    // A missing ephemeral-environment provider is a real setup gap ONLY when no zero-config
    // in-container test-env default exists. Stock Node's sole test-env backend is the
    // `environment-provider`, so it's required here; local mode on a Docker-family runtime
    // advertises `local-compose` (docker-compose in the run's container, no connection), which
    // flips this false so the "test environment not configured" banner stays quiet. Derived from
    // the capability descriptor local already populated, so the two can't drift.
    ephemeralEnvironmentsRequireProvider: !testEnvHasZeroConfigDefault(config.infrastructure),
    // pg-boss-backed async GitHub ingest when the durable engine is wired (the real
    // server drains the queue via `startGitHubSyncWorker`); inline fallback with no boss.
    // Built once above so the skill-freshness fan-out shares this same instance.
    gateways,
    // Source-control PAT login: lets a user sign in with their own GitHub/GitLab PAT via
    // `/auth/pat`, held to the server's login/org/domain allowlist. Local mode overrides this
    // (via its container spread) with a configured-token, allowlist-exempt registry.
    vcsIdentity: buildNodeVcsIdentityRegistry(config),
    // The app-owned VCS provider registry the neutral webhook route resolves a provider from.
    vcsRegistry,
    // The sensitive per-service test-credential store the shared test-secrets controller reads;
    // present when the shared ENCRYPTION_KEY is configured.
    ...(testSecretsService ? { testSecrets: testSecretsService } : {}),
    ...(capabilityCredentialsService
      ? { capabilityCredentials: capabilityCredentialsService }
      : {}),
    // The per-workspace MCP OAuth grant store the tool-server connect/disconnect routes and the
    // inventory's connection state read. Present when the shared ENCRYPTION_KEY is configured;
    // absent, the routes refuse with a 503 naming the key rather than pretending a grant can be
    // kept somewhere.
    // The per-workspace MCP OAuth grant store, plus the redirect URL a vendor's authorization
    // server sends the browser back to. Operator-set rather than derived from the request, because
    // a third party holds this exact string and a `Host`-derived one differs behind every proxy.
    ...mcpOAuthContainerFields({
      oauth: mcpOAuthService,
      redirectUrl: env.MCP_OAUTH_REDIRECT_URL,
    }),
    // The mirror image: this deployment as the authorization server for its OWN hosted MCP
    // endpoint, so a host connects by approving a consent screen instead of being handed a key.
    // Present only where both halves are (a key to seal what the flow carries, and the public-API
    // key store it issues from); the Worker facade projects the same fields.
    ...mcpAuthServerContainerFields({
      encryptionKey: env.ENCRYPTION_KEY,
      publicApiKeys,
      clock: dependencies.clock,
      logger: dependencies.logger,
    }),
    // Where the SPA is served, for the browser hand-off in that flow. Read from the same resolved
    // value the invite and password-reset links use (`APP_BASE_URL`, falling back to
    // `AUTH_SUCCESS_REDIRECT_URL`), so a deployment configures its app URL once.
    ...(config.email.appBaseUrl ? { appBaseUrl: config.email.appBaseUrl } : {}),
    // The composed capability-credential chain: the resolver the tool-server probe resolves through,
    // and what sits BEHIND the store, so the credential checklist describes the real chain instead of
    // asserting the default beside it. Both arrive already projected by
    // `toolSecretContainerFields`, so the description stays ABSENT rather than undefined when a
    // deployment supplied its own resolver and nothing here can describe what that consults.
    ...(toolSecretEnvironmentFallback === undefined ? {} : { toolSecretEnvironmentFallback }),
    toolSecretResolver,
    // The per-service pre-PR validation-check store the shared controller reads. Always present
    // (nothing sealed — the commands run inside the run's own container).
    validationConfig: validationConfigService,
    // The vendor-credential (subscription token pool) service the shared controller
    // reads; present when the shared ENCRYPTION_KEY is configured.
    subscriptions,
    // The per-user individual-usage subscription store (Claude); present when the
    // shared ENCRYPTION_KEY is configured.
    personalSubscriptions,
    // The direct-provider API-key pool (account/workspace/user); present when the
    // shared ENCRYPTION_KEY is configured.
    apiKeys,
    // The inbound public-API key store; present when the shared ENCRYPTION_KEY is configured.
    publicApiKeys,
    // The per-workspace outbound notification-webhook config; present when ENCRYPTION_KEY is set.
    notificationWebhooks,
    platformAlertSink,
    // Whether the opt-in Cloudflare Workers AI lib is enabled (REST creds present).
    cloudflareModelsEnabled,
    ...(bedrockModels ? { bedrockModels } : {}),
    // The direct-provider base-URL resolver the catalog uses to gate selectability on a
    // resolvable endpoint (e.g. Bifrost stays unselectable until BIFROST_BASE_URL is set).
    baseUrlFor: (provider) => baseUrlForNode(provider, env),
    // The per-user locally-run model endpoints store; present when ENCRYPTION_KEY is set.
    localModelEndpoints,
    // The per-user generic secret store (GitHub PAT, …); present when ENCRYPTION_KEY is set.
    userSecrets,
    // The per-user "repos my PAT can reach" projection (board redaction + picker expansion);
    // Postgres-backed, so absent in the no-DB mothership node (redaction degrades to visible).
    userRepoAccess: db ? new DrizzleUserRepoAccessRepository(db) : undefined,
    // The two ENCRYPTION_KEY-gated sealed-secret seams (inventory + cipher factory).
    ...selectNodeSealedSecretDeps(env, db),
    // The per-workspace OpenRouter dynamic-catalog store; present when the API-key pool is.
    openRouterCatalog,
    // Flush + release the external trace sink on graceful shutdown so the OpenTelemetry SDK
    // exporter's final batch of spans/metrics isn't dropped and its background timers are
    // cleared. Best-effort; a no-op for the fetch-based Langfuse sink and when nothing is
    // wired. (The local facade composes this into its own `onShutdown` — see its container.)
    onShutdown: async () => {
      await traceSink?.shutdown?.()
    },
  }
}

/**
 * The tail of {@link buildNodeContainer}: gather the real-time + per-account dependency groups,
 * apply the last-write-wins gate providers, assemble the engine {@link CoreDependencies}, wire the
 * optional preview + env-config-repair modules, re-source the mothership run-path repos, and
 * project the {@link ServerContainer} the HTTP layer resolves. Extracted verbatim from
 * {@link buildNodeContainer} (a function-size ratchet split — behaviour AND side-effect order are
 * identical), taking every local the composition root built as a single typed bundle.
 */
/**
 * The slots this root publishes into for the collaborators it builds BEFORE their contents exist.
 *
 * Both are read by the INLINE agent executor, which the model stack constructs early, and both are
 * produced later: the binary-artifact store by the per-account settings stack, the agent-context
 * recorder by the run-services stack. The orderings are not negotiable in either direction (the
 * account stack registers gate providers that must land before `applyGateProviders`; the model
 * stack must exist before the run platform that composes the executors), so they are bound by a
 * DEFERRED READ rather than by moving either.
 *
 * The same class of problem `applyNodePostAssemblyWiring` exists for, and handled the same way:
 * explicitly, in the root, with each read failing SAFE. An inline dispatch that runs before a slot
 * is filled (there is no such path today; nothing dispatches during assembly) resolves no store —
 * its prompt then states that the pictures could not be delivered, the honest answer for a
 * deployment with no storage too — and records no context snapshot, exactly as a deployment that
 * retains no telemetry does.
 */
interface NodeLateBindings {
  resolve?: ResolveBinaryArtifactStore
  /** @see AiAgentExecutorDependencies.agentContextRecorder */
  agentContextRecorder?: AgentContextRecorder
}

/**
 * Every slot of {@link NodeLateBindings}, each REQUIRED as a key while its value may still be
 * absent. That is what makes {@link publishLateBindings} total: adding a deferred slot above and
 * forgetting to publish it stops compiling, where the same omission on a bag of optional fields
 * compiles into a hole nothing can see — an unfilled slot reads exactly like a deployment that
 * wired the capability off.
 */
type PublishedLateBindings = { [K in keyof NodeLateBindings]-?: NodeLateBindings[K] }

/**
 * Fill every slot of {@link NodeLateBindings}, once, at the point in the root where all of them
 * exist. One call rather than an assignment per slot, and one TOTAL object rather than a positional
 * list, so each slot is named at the call site and none can be skipped.
 */
function publishLateBindings(slots: NodeLateBindings, values: PublishedLateBindings): void {
  Object.assign(slots, values)
}

interface NodeContainerFinalizeBundle {
  /**
   * Where this root publishes the values built AFTER the collaborators that read them.
   * See {@link NodeLateBindings}.
   */
  artifactStore: NodeLateBindings
  config: AppConfig
  options: NodeContainerOptions
  env: NodeJS.ProcessEnv
  db: DrizzleDb
  repos: ReturnType<typeof createDrizzleRepositories>
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T
  idGenerator: CoreDependencies['idGenerator']
  clock: CoreDependencies['clock']
  standardAgentExecutor: Parameters<typeof buildNodeRealtimeDeps>[0]['standardAgentExecutor']
  modelProviderResolver: NodeModelDepsResult['modelProviderResolver']
  resolveWorkspaceModelDefault: Parameters<
    typeof buildNodeRealtimeDeps
  >[0]['resolveWorkspaceModelDefault']
  resolvePresetProviderPreference: NodeContainerFoundation['resolvePresetProviderPreference']
  agentKindRegistry: NodeAppRegistriesResult['agentKindRegistry']
  providerRegistry: NodeAppRegistriesResult['providerRegistry']
  packageRegistrySecretCipher: NodeRunServicesResult['packageRegistrySecretCipher']
  githubInstallationRepository: GitHubInstallationRepository
  /**
   * The run path's "initiator PAT or deployment credential?" answer, forwarded from the run
   * platform so the container can surface it for the board-load credential check.
   */
  resolveRunInitiatorToken: ResolveRunInitiatorToken | undefined
  environmentBackendRegistry: NodeAppRegistriesResult['environmentBackendRegistry']
  runnerBackendRegistry: NodeAppRegistriesResult['runnerBackendRegistry']
  customManifestTypeRegistry: NodeAppRegistriesResult['customManifestTypeRegistry']
  gateRegistry: NodeAppRegistriesResult['gateRegistry']
  judgeRegistry: NodeAppRegistriesResult['judgeRegistry']
  stepResolverRegistry: NodeAppRegistriesResult['stepResolverRegistry']
  initiativePresetRegistry: NodeAppRegistriesResult['initiativePresetRegistry']
  apiKeys: NodeModelDepsResult['apiKeys']
  subscriptions: NodeModelDepsResult['subscriptions']
  personalSubscriptions: NodeModelDepsResult['personalSubscriptions']
  localModelEndpoints: NodeModelDepsResult['localModelEndpoints']
  openRouterCatalog: NodeModelDepsResult['openRouterCatalog']
  cloudflareModelsEnabled: NodeModelDepsResult['cloudflareModelsEnabled']
  deployDeps: NodeTransportDeployResult['deployDeps']
  runnerPoolConnectionRepository: CoreDependencies['runnerPoolConnectionRepository']
  agentContextObservability: NodeRunServicesResult['agentContextObservability']
  searchQueryObservability: NodeRunServicesResult['searchQueryObservability']
  resolveTestSecretRefs: NodeRunServicesResult['resolveTestSecretRefs']
  resolveValidationChecks: NodeRunServicesResult['resolveValidationChecks']
  githubClient: NodeGitHubDepsResult['githubClient']
  tasks: NodeGitHubDepsResult['tasks']
  fileGitHubIssue: NodeGitHubDepsResult['fileGitHubIssue']
  issueWritebackProvider: NodeGitHubDepsResult['issueWritebackProvider']
  githubGateDeps: NodeGitHubDepsResult['githubGateDeps']
  githubModuleDeps: NodeGitHubDepsResult['githubModuleDeps']
  bootstrapJobRepository: NodeBootstrapperResult['bootstrapJobRepository']
  repoBootstrapper: NodeBootstrapperResult['repoBootstrapper']
  resolveRepoTarget: ReturnType<typeof buildResolveRepoTarget>
  /** The board-wide run-target set the credential check reads (see `ServerContainer`). */
  listWorkspaceRunRepos: ListWorkspaceRunRepos
  baseDeployMint: NodeTransportDeployResult['baseDeployMint']
  resolveTransport: NodeTransportDeployResult['resolveTransport']
  bootstrapMintInstallationToken: NodeBootstrapperResult['bootstrapMintInstallationToken']
  remoteRepos: Record<string, unknown> | undefined
  defaultWebSearchUpstream: NodeRunServicesResult['defaultWebSearchUpstream']
  appRegistry: ReturnType<typeof buildNodeAppRegistry>
  repoProjectionRepository: DrizzleRepoProjectionRepository
  vcsRegistry: NodeAppRegistriesResult['vcsRegistry']
  testSecretsService: NodeRunServicesResult['testSecretsService']
  capabilityCredentialsService: NodeRunServicesResult['capabilityCredentialsService']
  mcpOAuthService: NodeRunServicesResult['mcpOAuthService']
  /**
   * The composed capability-credential chain, as `toolSecretContainerFields` projects it: the
   * resolver the tool-server probe resolves through, plus whether this node's environment answers
   * behind the per-workspace store. The description is ABSENT (not undefined) when a deployment
   * replaced the chain with its own resolver, because the checklist renders three states off that
   * distinction.
   */
  toolSecretEnvironmentFallback?: boolean
  toolSecretResolver: ToolSecretResolver
  validationConfigService: NodeRunServicesResult['validationConfigService']
  publicApiKeys: NodeModelDepsResult['publicApiKeys']
  userSecrets: NodeModelDepsResult['userSecrets']
  traceSink: NodeModelDepsResult['traceSink']
}

/**
 * Settle the gate-provider registry, once every module that contributes to it has run.
 *
 * The two halves belong together and in this order. Test-injected providers are applied LAST so
 * they override the config wiring (the cross-runtime conformance suite drives the externalized CI
 * gate over a faked verdict; in local mode a PAT-backed CI provider is wired earlier and would
 * otherwise win) — production leaves `gateProviders` undefined, so that is a no-op outside tests.
 * Then every gate still left as a silent pass-through is named in the logs, because the failure
 * shape of an unwired gate is a deployment auto-merging without ever checking CI.
 */
function finalizeGateProviders(
  providerRegistry: NodeAppRegistriesResult['providerRegistry'],
  gateProviders: NodeContainerOptions['gateProviders'],
): void {
  applyGateProviders(providerRegistry, gateProviders)
  warnUnwiredGates(providerRegistry, logger)
}

function finalizeNodeContainer(bundle: NodeContainerFinalizeBundle): ServerContainer {
  const {
    artifactStore,
    config,
    options,
    env,
    db,
    repos,
    sourced,
    idGenerator,
    clock,
    standardAgentExecutor,
    modelProviderResolver,
    resolveWorkspaceModelDefault,
    resolvePresetProviderPreference,
    agentKindRegistry,
    providerRegistry,
    packageRegistrySecretCipher,
    githubInstallationRepository,
    resolveRunInitiatorToken,
    listWorkspaceRunRepos,
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    apiKeys,
    subscriptions,
    personalSubscriptions,
    localModelEndpoints,
    openRouterCatalog,
    cloudflareModelsEnabled,
    deployDeps,
    runnerPoolConnectionRepository,
    agentContextObservability,
    searchQueryObservability,
    resolveTestSecretRefs,
    resolveValidationChecks,
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
    bootstrapJobRepository,
    repoBootstrapper,
    resolveRepoTarget,
    baseDeployMint,
    resolveTransport,
    bootstrapMintInstallationToken,
    remoteRepos,
    defaultWebSearchUpstream,
    appRegistry,
    repoProjectionRepository,
    vcsRegistry,
    testSecretsService,
    capabilityCredentialsService,
    mcpOAuthService,
    toolSecretEnvironmentFallback,
    toolSecretResolver,
    validationConfigService,
    publicApiKeys,
    userSecrets,
    traceSink,
  } = bundle

  // Real-time event publisher + notification channel + optional consensus wrap, lifted into
  // `container-realtime-deps.ts` to keep this root within the file-size budget.
  const {
    slackDeps,
    executionEventPublisher,
    agentExecutor,
    notificationChannel,
    externalNotificationChannel,
    notificationWebhookSupport,
    notificationSettingsRepository,
  } = buildNodeRealtimeDeps({
    env,
    config,
    repos,
    sourced,
    realtimeSink: options.realtimeSink,
    standardAgentExecutor,
    modelProviderResolver,
    resolveWorkspaceModelDefault,
    agentKindRegistry,
    clock,
    ...(options.notificationChannels
      ? { extraNotificationChannels: options.notificationChannels }
      : {}),
  })

  // Per-account settings + binary-artifact storage + the observability/incident gate-provider
  // wiring (onto `providerRegistry`, before `applyGateProviders` below), plus the package-registry
  // management deps, lifted into `container-account-deps.ts` to keep this root within budget.
  const {
    releaseHealthDeps,
    packageRegistryDeps,
    incidentEnrichmentDeps,
    accountSettings,
    resolveBinaryArtifactStore,
  } = buildNodeAccountDeps({
    env,
    config,
    db,
    repos,
    idGenerator,
    clock,
    providerRegistry,
    packageRegistrySecretCipher,
    ...(options.secretDelegate ? { secretDelegate: options.secretDelegate } : {}),
    contentStorageDefaultBackend: options.contentStorageDefaultBackend,
    binaryStoreRegistry: options.binaryStoreRegistry,
    caches: options.caches,
  })
  publishLateBindings(artifactStore, {
    resolve: resolveBinaryArtifactStore,
    agentContextRecorder: agentContextObservability,
  })

  // Runner-pool URL/host guard, scoped to its own config (independent of the environment
  // allow-list); absent => strict public-https.
  const runnerUrlPolicy = resolveUrlSafetyPolicy(config.runners)

  finalizeGateProviders(providerRegistry, options.gateProviders)

  // pg-boss-backed async GitHub ingest (webhook/resync/backfill) when the durable engine is
  // wired; inline fallback with no boss. Built once so the engine's skill-freshness fan-out
  // (slice 4) enqueues through the SAME `githubWebhook` seam rather than re-deriving the queue.
  const gateways = createNodeGateways(env, options.boss)

  const dependencies = assembleNodeCoreDependencies({
    config,
    options,
    env,
    db,
    repos,
    sourced,
    idGenerator,
    clock,
    gateways,
    runnerUrlPolicy,
    githubInstallationRepository,
    resolveRunInitiatorToken,
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    providerRegistry,
    apiKeys,
    subscriptions,
    personalSubscriptions,
    localModelEndpoints,
    openRouterCatalog,
    modelProviderResolver,
    cloudflareModelsEnabled,
    deployDeps,
    runnerPoolConnectionRepository,
    agentContextObservability,
    searchQueryObservability,
    resolveTestSecretRefs,
    resolveValidationChecks,
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
    bootstrapJobRepository,
    repoBootstrapper,
    slackDeps,
    executionEventPublisher,
    agentExecutor,
    notificationChannel,
    notificationSettingsRepository,
    runLifecycleSink: notificationWebhookSupport?.runLifecycleSink,
    releaseHealthDeps,
    packageRegistryDeps,
    incidentEnrichmentDeps,
    accountSettings,
    resolveBinaryArtifactStore,
    resolvePresetProviderPreference,
  })

  // The post-assembly adjustments (preview module, env-config repairer, mothership re-sourcing),
  // each of which needs the FINAL dependency object — see the collaborator.
  applyNodePostAssemblyWiring(dependencies, {
    options,
    env,
    config,
    repos,
    resolveRepoTarget,
    repoProjectionRepository,
    baseDeployMint,
    resolveTransport,
    githubInstallationRepository,
    bootstrapMintInstallationToken,
    environmentBackendRegistry,
    remoteRepos,
  })

  return projectNodeServerContainer({
    dependencies,
    config,
    externalNotificationChannel,
    defaultWebSearchUpstream,
    resolveRepoTarget,
    listWorkspaceRunRepos,
    repos,
    appRegistry,
    options,
    repoProjectionRepository,
    githubInstallationRepository,
    environmentBackendRegistry,
    runnerBackendRegistry,
    resolveBinaryArtifactStore,
    gateways,
    vcsRegistry,
    testSecretsService,
    capabilityCredentialsService,
    mcpOAuthService,
    toolSecretEnvironmentFallback,
    toolSecretResolver,
    validationConfigService,
    subscriptions,
    personalSubscriptions,
    apiKeys,
    publicApiKeys,
    notificationWebhooks: notificationWebhookSupport?.service,
    platformAlertSink: notificationWebhookSupport?.platformAlertSink,
    cloudflareModelsEnabled,
    env,
    localModelEndpoints,
    userSecrets,
    db,
    openRouterCatalog,
    traceSink,
  })
}

export function buildNodeContainer(options: NodeContainerOptions): ServerContainer {
  // The composition-root foundation: the resolved env/config (+ the Node infrastructure
  // descriptor), the clock/id generator, the repository set with its mothership-aware `sourced`
  // picker, the app-owned registries, the opt-in GitLab engine client, and the workspace
  // model-preset resolver. Lifted into `container-foundation.ts` so this root stays within the
  // per-function line budget; every side effect (the `config.infrastructure ??=` fill, the
  // `registerGitLab` registration) still happens here, first, exactly as before.
  const foundation = resolveNodeContainerFoundation(options)
  const {
    env,
    config,
    clock,
    idGenerator,
    repos,
    db,
    remoteRepos,
    sourced,
    registries,
    resolveWorkspaceModelDefault,
    resolvePresetProviderPreference,
  } = foundation
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    userSecretKindRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    vcsRegistry,
    providerRegistry,
  } = registries

  // The credential/token stores + the model-provisioning stack (API-key pool, public-API +
  // local-model-endpoint + user-secret + OpenRouter + subscription + personal-subscription
  // stores, the trace sink, the model-provider resolver, and the inline executor), lifted into
  // `container-model-deps.ts` so this composition root stays within the file-size budget.
  // See {@link NodeLateBindings}: the artifact store and the agent-context recorder are both
  // built further down this function, and the inline executor below reads through each.
  const artifactStore: NodeLateBindings = {}
  const models = buildNodeModelDeps({
    env,
    config,
    db,
    workspaceRepository: repos.workspaceRepository,
    idGenerator,
    clock,
    agentKindRegistry,
    userSecretKindRegistry,
    resolveWorkspaceModelDefault,
    providerApiKeyRepository: options.providerApiKeyRepository,
    localModelEndpointRepository: options.localModelEndpointRepository,
    providerSubscriptionTokenRepository: options.providerSubscriptionTokenRepository,
    personalSubscriptionRepository: options.personalSubscriptionRepository,
    subscriptionActivationRepository: options.subscriptionActivationRepository,
    wrapModelProviderResolver: options.wrapModelProviderResolver,
    cloudflareModelsEnabled: options.cloudflareModelsEnabled,
    caches: options.caches,
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    llmCallMetricRepository: repos.llmCallMetricRepository,
    // The inline executor reads the bytes of a task's design pictures through the same account
    // store the container path serves them from, so an inline kind sees the design its container
    // sibling does. Deferred, because that store is composed later in this function.
    resolveBinaryArtifactStore: (workspaceId) =>
      artifactStore.resolve?.(workspaceId) ?? Promise.resolve(null),
    // Deferred for the same reason, and through the same slot: the run-services stack builds the
    // recorder. Wired so an INLINE kind's provided context reaches `agent_context_snapshots` too,
    // which is what the container executor's own wiring alone left out.
    agentContextRecorder: {
      record: (snapshot) =>
        artifactStore.agentContextRecorder?.record(snapshot) ?? Promise.resolve(),
    },
  })

  // Everything the engine needs to actually RUN a block: repo resolution, the runner transport +
  // deploy seams, the per-run services, the agent executor, the GitHub-client-dependent
  // integration slice, and the repo bootstrapper. Lifted into `container-run-platform.ts` so this
  // root stays within the per-function line budget. Every field of the bundle is consumed by the
  // finalize step below, so it is SPREAD there rather than re-listed here.
  const platform = buildNodeRunPlatform({ options, foundation, models })

  const {
    apiKeys,
    publicApiKeys,
    localModelEndpoints,
    userSecrets,
    openRouterCatalog,
    subscriptions,
    personalSubscriptions,
    traceSink,
    modelProviderResolver,
    cloudflareModelsEnabled,
  } = models
  return finalizeNodeContainer({
    // The run-platform bundle, forwarded as a unit (see `platform` above).
    ...platform,
    artifactStore,
    config,
    options,
    env,
    db,
    repos,
    sourced,
    idGenerator,
    clock,
    modelProviderResolver,
    resolveWorkspaceModelDefault,
    resolvePresetProviderPreference,
    agentKindRegistry,
    providerRegistry,
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    apiKeys,
    subscriptions,
    personalSubscriptions,
    localModelEndpoints,
    openRouterCatalog,
    cloudflareModelsEnabled,
    remoteRepos,
    vcsRegistry,
    publicApiKeys,
    userSecrets,
    traceSink,
  })
}

/**
 * Wire the task-source integration for the Node facade when it is enabled (the
 * `tasks` module then assembles so tenants can connect Jira through the existing
 * UI). Returns the `CoreDependencies` fragment plus the connection repository so the
 * tracker can resolve each workspace's Jira credentials from the same store.
 * No registered providers → `{ deps: {} }` and both the tasks module and the Jira
 * tracker stay off (the encryption key is guaranteed present by `loadTasksConfig`).
 */

/**
 * The deployment's two sealed-secret seams, the Node twin of the Worker's
 * `selectWorkerSealedSecretDeps`, in the same shape and for the same reason: they are one concern
 * read from one variable, and keeping the facades legible side by side is what makes a seam wired
 * on one visibly missing from the other.
 *
 * BOTH are gated on `db` as well as the key, and the `db` half is what makes the pair correct
 * rather than merely tidy. On Node, no `db` means MOTHERSHIP MODE (`buildNodeContainer` asserts
 * exactly that: a db-less boot must supply the RPC-backed `repos` instead), and a mothership-mode
 * node is the one deployment that must never answer `/internal/secrets/*`. Its `ENCRYPTION_KEY` is
 * the LOCAL key that seals its own agent/model credentials, which is a different key from the one
 * the org's rows were sealed under, so answering there would seal a delegated `POST .../seal` under
 * a key the org cannot read: the silent split the delegation exists to remove, one write later.
 *
 * The `repositories` registry cannot stand in for this check, which is why the gate lives here.
 * A mothership-mode node populates it too (with the REMOTE, RPC-backed repos), so it is present on
 * exactly the deployment it would need to exclude; the capability the controller 503s on has to be
 * the one seam only an authoritative deployment wires, and that is the cipher. The Worker takes a
 * non-optional `D1Database` and so is always authoritative, which is why its twin gates on the key
 * alone.
 */
function selectNodeSealedSecretDeps(
  env: NodeJS.ProcessEnv,
  db: DrizzleDb | undefined,
): Pick<ServerContainer, 'sealedSecretInventory' | 'secretCipherFor'> {
  const masterKeyBase64 = env.ENCRYPTION_KEY?.trim()
  if (!masterKeyBase64 || !db) return {}
  return {
    // ADR 0026 D6.2/D6.3: what the boot drift sweep attempts to decrypt, and what an operator's
    // drop remediation targets.
    sealedSecretInventory: new DrizzleSealedSecretInventory(db),
    // What `/internal/secrets/{unseal,seal}` opens and seals an ORG credential through on a
    // mothership-mode node's behalf.
    secretCipherFor: (info: string) => new WebCryptoSecretCipher({ masterKeyBase64, info }),
  }
}
