// The Node composition root's THIRD layer, between `container-foundation.ts` (env/config,
// repositories, registries) and `container-core-deps.ts` (the finalize bundle): everything the
// engine needs to actually RUN a block — repo resolution, the runner transport + deploy seams, the
// per-run services, the agent executor, the GitHub-client-dependent integration slice, and the repo
// bootstrapper.
//
// Lifted out of `buildNodeContainer` so that root stays within the per-function line budget. The
// order of every statement here is unchanged from when it lived inline, which matters: the
// `selectNodeGitHubDeps` call registers gate providers onto `providerRegistry` as a side effect and
// must stay BEFORE `applyGateProviders` in the finalize step.
import {
  type AppCaches,
  type BlockRepository,
  type Clock,
  type GitHubInstallationRepository,
  type Logger,
  type RepoProjectionRepository,
  type ServiceRepository,
  createInitiatorPatGate,
} from '@cat-factory/kernel'
import {
  type AppConfig,
  CompositeAgentExecutor,
  GitHubAppAuth,
  GitHubAppRegistry,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  type ToolSecretChain,
  buildToolSecretChain,
  mcpOAuthExecutorDeps,
  toolSecretContainerFields,
  createResolveRunInitiatorToken,
  logger,
} from '@cat-factory/server'

import type { NodeContainerOptions } from './container-options.js'
import type { resolveNodeContainerFoundation } from './container-foundation.js'
import type { buildNodeModelDeps } from './container-model-deps.js'
import { selectNodeGitHubDeps } from './container-github-deps.js'
import { buildNodeRunServices } from './container-run-services-deps.js'
import { buildNodeBootstrapper, buildNodeTransportDeploy } from './container-transport-deps.js'
import {
  type NodeContainerExecutorDeps,
  buildNodeContainerExecutor,
} from './container-executor-deps.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRunnerPoolConnectionRepository,
} from './repositories/containerExecution.js'
import { DrizzleRepoProjectionRepository } from './repositories/github.js'

/**
 * The workspace-spanning GitHub App registry, built once and shared by everything that
 * needs an App credential: the container executor's push-token mint, the tech-debt
 * issue filer, and the CI / merge / mergeability gate client. Returns undefined when
 * the App isn't configured (`github.enabled` + `GITHUB_APP_PRIVATE_KEY`), so each
 * caller degrades the way it always has.
 */
export function buildNodeAppRegistry(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
): GitHubAppRegistry | undefined {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  if (!config.github.enabled || !privateKeyPem) return undefined
  const makeAuth = (appId: string, key: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem: key,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  // Privileged App tier (ADR 0005): the second App carries `Administration: write`
  // for repo provisioning. Activates only when both its config id and key are
  // present, mirroring the Worker's `buildAppRegistry`.
  const privilegedKey = env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY?.trim()
  const privileged =
    config.github.privilegedApp && privilegedKey
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, privilegedKey),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, privateKeyPem),
    },
    privileged,
    installationRepository,
  })
}

export interface NodeRunPlatformInput {
  options: NodeContainerOptions
  foundation: ReturnType<typeof resolveNodeContainerFoundation>
  models: ReturnType<typeof buildNodeModelDeps>
}

/**
 * Assemble the run platform. Every field of the returned bundle is consumed by the finalize step,
 * so the root spreads it wholesale rather than re-listing it — the same reason the per-run
 * `runServices` bundle (spread in here) is kept as one value.
 */
/**
 * The two block → repo resolvers, built together off the ONE dependency set they share.
 *
 * They answer the same question at two arities — which repo does this block's work target, and
 * which repos does a cross-service run touch — and read the same installation, projection, block
 * and service repositories to do it. Built side by side so a change to that shared set (a new
 * cache, a re-sourced repository) cannot reach one and miss the other, which is how the singular
 * resolver and the multi-repo one would come to disagree about a block's own repo.
 */
function buildNodeRepoResolvers(deps: {
  installationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  blockRepository: BlockRepository
  serviceRepository: ServiceRepository
  repoProjectionCache?: AppCaches['repoProjection']
}) {
  // BOTH resolvers get the projection cache. They read the same whole-workspace list, on the
  // same hot paths, and it is invalidated by the same projection writes (slice 3; the GitHub
  // sync/webhook module + bootstrapper invalidate the bag after every write). Handing it to one
  // of them is how the cheap resolver and the expensive one end up looking alike at the call
  // site while costing an order of magnitude apart.
  return {
    // The repo a running block targets (installation + owner/name), resolved from the
    // github_repos projection. Built once and shared by the container executor, the
    // GitHub-issue tracker filer, and the CI / merge providers.
    resolveRepoTarget: buildResolveRepoTarget(deps),
    // The MULTI-REPO resolver (service-connections phase 3): the task's own repo plus each
    // connected involved-service repo, deduped (the service repo's batched `listByFrameBlocks`
    // resolves the involved frames in one query). Fed to the container executor so the
    // implementer can fan a cross-service change out across sibling checkouts, and to the PR
    // verification report so it reaches the peer PRs that fan-out opened.
    resolveRepoTargets: buildResolveRepoTargets(deps),
  }
}

export function buildNodeRunPlatform({ options, foundation, models }: NodeRunPlatformInput) {
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
    gitlabEngineClient,
    resolveWorkspaceModelDefault,
  } = foundation
  const { runnerBackendRegistry, agentKindRegistry, providerRegistry } = registries
  const { subscriptions, personalSubscriptions, resolveUserGitHubToken, inline } = models

  // Persistence the container-execution path needs (built from the same db). The
  // runner-pool repo also backs the `runners` Core module so a pool is registrable
  // via the API; the installation repo backs both token minting and repo resolution.
  const runnerPoolConnectionRepository = sourced(
    'runnerPoolConnectionRepository',
    (d) => new DrizzleRunnerPoolConnectionRepository(d),
  )
  const githubInstallationRepository =
    options.githubInstallationRepository ??
    sourced('githubInstallationRepository', (d) => new DrizzleGitHubInstallationRepository(d))
  // The repositories projection (+ sync cursors), shared by `buildResolveRepoTarget`
  // (block→repo resolution) and the GitHub sync/webhook module below.
  const repoProjectionRepository = sourced(
    'repoProjectionRepository',
    (d) => new DrizzleRepoProjectionRepository(d),
  )

  const appRegistry = buildNodeAppRegistry(env, config, clock, githubInstallationRepository)

  // "Does THIS run act with its initiator's own GitHub token?" — built ONCE here and shared by
  // the container push-token mint and the engine's GitHub client (CI gate / mergeability /
  // merge), so the workspace's `allowInitiatorPat` switch cannot bind one path and miss the
  // other. Undefined when no per-user secret store is wired (no `ENCRYPTION_KEY`), which is
  // the same condition that already made the preference inert.
  const resolveRunInitiatorToken = resolveUserGitHubToken
    ? createResolveRunInitiatorToken({
        resolveUserGitHubToken,
        initiatorPatGate: createInitiatorPatGate({
          repository: repos.workspaceSettingsRepository,
          ...(options.caches?.workspaceSettings ? { cache: options.caches.workspaceSettings } : {}),
          // The account-wide floor. Read off the REPOSITORY rather than
          // `AccountSettingsService`, deliberately: the service needs an `ENCRYPTION_KEY` to
          // open the account's secrets, which a mothership node does not have — so building
          // the floor from the service would have made it silently inert on exactly the
          // deployment shape where an operator scoped things centrally. The repo's
          // config-only read needs no key and is proxied.
          account: {
            resolveAccountId: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
            readAllowInitiatorPat: async (accountId) =>
              (await repos.accountSettingsRepository.getConfigByAccount(accountId))
                .allowInitiatorPat,
          },
        }),
        logger,
      })
    : undefined

  // Block → repo(s) resolution, singular and multi-repo, off one shared dependency set.
  const { resolveRepoTarget, resolveRepoTargets } = buildNodeRepoResolvers({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    // The org service repo (its `getByFrameBlock` is all `buildResolveRepoTarget` needs); already
    // in `repos`, so it is the Drizzle repo over `db` in a standard build and the remote proxy in
    // mothership mode — no separate direct-db `DrizzleServiceFrameRepository` construction.
    serviceRepository: repos.serviceRepository,
    repoProjectionCache: options.caches?.repoProjection,
  })

  // The runner-transport resolver + the container-backed deploy lifecycle seams (resolve the
  // workspace's transport, wrap it with the provisioning-log decorator, build the deploy job
  // client + clone-target resolver), lifted into `container-transport-deps.ts`.
  const { resolveTransport, baseDeployMint, deployDeps } = buildNodeTransportDeploy({
    config,
    repos,
    idGenerator,
    clock,
    runnerPoolConnectionRepository,
    runnerBackendRegistry,
    appRegistry,
    resolveRepoTarget,
    workspaceRepository: repos.workspaceRepository,
    resolveTransportOverride: options.resolveTransport,
    runnerPoolProvider: options.runnerPoolProvider,
    skipProvisioningLogWrap: options.skipProvisioningLogWrap,
    mintInstallationToken: options.mintInstallationToken,
    deployJobClientOverride: options.deployJobClient,
    disableDefaultDeployJobClient: options.disableDefaultDeployJobClient,
    resolveDeployCloneTargetOverride: options.resolveDeployCloneTarget,
    resolveRepoOrigin: options.resolveRepoOrigin,
  })
  // The per-run agent-observability + web-search + sealed-secret services (agent-context /
  // search-query / harness-call telemetry sinks, the web-search upstream + availability
  // resolver, the package-registry + test-secret dispatch resolvers, the subscription-quota
  // provider), lifted into `container-run-services-deps.ts`. Kept as ONE value and SPREAD into
  // the returned bundle rather than destructured field-by-field: every field is either forwarded
  // verbatim or read at a single call site, so the destructure was ~13 lines of pure re-listing
  // that had to be edited twice per new run service.
  const runServices = buildNodeRunServices({
    env,
    config,
    repos,
    idGenerator,
    clock,
    caches: options.caches,
    logger,
  })

  const { toolSecretChain, executorCapabilityDeps } = buildNodeCapabilityCredentials({
    env,
    options,
    runServices,
    logger,
  })

  const container = buildNodeContainerExecutor({
    env,
    config,
    appRegistry,
    resolveRepoTarget,
    resolveRepoTargets,
    resolveTransport,
    resolveWorkspaceModelDefault,
    agentKindRegistry,
    mintInstallationTokenOverride: options.mintInstallationToken,
    subscriptions,
    personalSubscriptions,
    resolveAccountId: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
    ...(resolveRunInitiatorToken ? { resolveRunInitiatorToken } : {}),
    agentContextObservability: runServices.agentContextObservability,
    resolveWebSearchAvailability: runServices.resolveWebSearchAvailability,
    resolveRepoOrigin: options.resolveRepoOrigin,
    resolvePackageRegistries: runServices.resolvePackageRegistries,
    resolveTestSecrets: runServices.resolveTestSecrets,
    ...executorCapabilityDeps,
    ...runServices.executorTelemetry,
    recordSubscriptionQuotaUsage: (target, usage) =>
      runServices.subscriptionQuotaProvider.recordUsage(target, usage),
  })

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  // Optionally wrapped with the consensus mechanism in the finalize step, after the event
  // publisher is built, so live consensus pushes ride the same hub.
  const standardAgentExecutor = new CompositeAgentExecutor(inline, container, agentKindRegistry)

  // The GitHub-client-dependent slice of the composition root: the engine's GitHub client, the
  // CI / mergeability / review / doc-quality gate-provider wiring (registered onto
  // `providerRegistry` as a side effect — kept BEFORE `applyGateProviders` in finalize), the
  // task-source deps, issue writeback, and the GitHub gate + projection/sync module deps. Lifted
  // into `container-github-deps.ts`, mirroring the Worker's `selectGitHubDeps`.
  const {
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
  } = selectNodeGitHubDeps({
    config,
    db,
    remoteRepos,
    sourced,
    ...(options.secretDelegate ? { secretDelegate: options.secretDelegate } : {}),
    idGenerator,
    clock,
    appRegistry,
    githubClientOverride: options.githubClient,
    ...(resolveRunInitiatorToken ? { resolveRunInitiatorToken } : {}),
    gitlabEngineClient,
    providerRegistry,
    resolveRepoTarget,
    resolveRepoTargets,
    resolveRepoOrigin: options.resolveRepoOrigin,
    githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    workspaceRepository: repos.workspaceRepository,
    caches: options.caches,
  })

  // Repo-bootstrap: the reference-architecture library + the container-dispatching
  // `repoBootstrapper`, lifted into `container-transport-deps.ts`.
  const { bootstrapJobRepository, bootstrapMintInstallationToken, repoBootstrapper } =
    buildNodeBootstrapper({
      env,
      config,
      sourced,
      resolveTransport,
      githubInstallationRepository,
      repoProjectionRepository,
      appRegistry,
      githubClient,
      mintInstallationToken: options.mintInstallationToken,
      resolvePackageRegistries: runServices.resolvePackageRegistries,
      caches: options.caches,
    })

  return {
    ...runServices,
    runnerPoolConnectionRepository,
    githubInstallationRepository,
    repoProjectionRepository,
    appRegistry,
    resolveRepoTarget,
    resolveTransport,
    baseDeployMint,
    deployDeps,
    standardAgentExecutor,
    // The composed capability-credential chain: the resolver the tool-server probe resolves through
    // (a probe must resolve exactly as a dispatch would) plus the description the credential
    // checklist renders. One shared projection, so the facades cannot drift about the pair.
    ...toolSecretContainerFields(toolSecretChain),
    githubClient,
    tasks,
    fileGitHubIssue,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
    bootstrapJobRepository,
    bootstrapMintInstallationToken,
    repoBootstrapper,
  }
}

/**
 * How a registered capability's credentials are resolved at dispatch, both halves: the composed
 * `ToolSecretResolver` chain (the per-workspace store in front of this node's environment, or a
 * deployment's own resolver, which replaces it) and the OAuth token source that mints a remote
 * server's access token from the sealed grant store.
 *
 * Composed HERE rather than inside the executor builder because the credential CHECKLIST has to
 * describe the chain the deployment actually got, and an executor cannot say what it was handed —
 * so the chain travels with its own description. The two halves are returned together because the
 * OAuth source resolves its CLIENT SECRET through that same chain: building them apart is what
 * would let a deployment's own resolver serve one and not the other.
 */
function buildNodeCapabilityCredentials(input: {
  env: NodeJS.ProcessEnv
  options: NodeContainerOptions
  runServices: ReturnType<typeof buildNodeRunServices>
  logger: Logger
}): {
  toolSecretChain: ToolSecretChain
  executorCapabilityDeps: Pick<
    NodeContainerExecutorDeps,
    'resolveToolSecrets' | 'resolveToolServerOAuth'
  >
} {
  const { env, options, runServices, logger } = input
  const toolSecretChain = buildToolSecretChain({
    custom: options.createToolSecretResolver?.(env),
    credentials: runServices.capabilityCredentialsService,
    env,
    environmentFallback: options.capabilityCredentialEnvironmentFallback,
    logger,
  })
  return {
    toolSecretChain,
    executorCapabilityDeps: {
      resolveToolSecrets: toolSecretChain.resolver,
      // Absent when this deployment has no ENCRYPTION_KEY, which is what makes a dispatch state an
      // OAuth server as `oauth_not_connected` rather than send a request with no token.
      ...mcpOAuthExecutorDeps({
        oauth: runServices.mcpOAuthService,
        resolveToolSecrets: toolSecretChain.resolver,
        logger,
      }),
    },
  }
}
