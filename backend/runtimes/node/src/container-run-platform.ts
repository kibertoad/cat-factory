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
  type Clock,
  type GitHubInstallationRepository,
  createInitiatorPatGate,
} from '@cat-factory/kernel'
import {
  type AppConfig,
  CompositeAgentExecutor,
  GitHubAppAuth,
  GitHubAppRegistry,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  createResolveRunInitiatorToken,
  logger,
} from '@cat-factory/server'

import type { NodeContainerOptions } from './container-options.js'
import type { resolveNodeContainerFoundation } from './container-foundation.js'
import type { buildNodeModelDeps } from './container-model-deps.js'
import { selectNodeGitHubDeps } from './container-github-deps.js'
import { buildNodeRunServices } from './container-run-services-deps.js'
import { buildNodeBootstrapper, buildNodeTransportDeploy } from './container-transport-deps.js'
import { buildNodeContainerExecutor } from './container-executor-deps.js'
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

  // The repo a running block targets (installation + owner/name), resolved from the
  // github_repos projection. Built once and shared by the container executor, the
  // GitHub-issue tracker filer, and the CI / merge providers.
  const resolveRepoTarget = buildResolveRepoTarget({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    // The org service repo (its `getByFrameBlock` is all `buildResolveRepoTarget` needs); already
    // in `repos`, so it is the Drizzle repo over `db` in a standard build and the remote proxy in
    // mothership mode — no separate direct-db `DrizzleServiceFrameRepository` construction.
    serviceRepository: repos.serviceRepository,
    // Cache the whole-projection re-list per workspace (slice 3); the GitHub sync/webhook
    // module + bootstrapper invalidate the same bag on every projection write.
    repoProjectionCache: options.caches?.repoProjection,
  })

  // The MULTI-REPO resolver (service-connections phase 3): the task's own repo plus each
  // connected involved-service repo, deduped (the service repo's batched `listByFrameBlocks`
  // resolves the involved frames in one query). Fed to the container executor so the
  // implementer can fan a cross-service change out across sibling checkouts.
  const resolveRepoTargets = buildResolveRepoTargets({
    installationRepository: githubInstallationRepository,
    repoProjectionRepository,
    blockRepository: repos.blockRepository,
    serviceRepository: repos.serviceRepository,
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
    // A deployment's own capability-credential resolver (per-workspace store, secret manager, or
    // just the env default narrowed by `allowKeys`). Absent ⇒ the executor builds the
    // deployment-environment default over the same `env`.
    ...(options.createToolSecretResolver
      ? { resolveToolSecrets: options.createToolSecretResolver(env) }
      : {}),
    recordHarnessCalls: runServices.recordHarnessCalls,
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
    idGenerator,
    clock,
    appRegistry,
    githubClientOverride: options.githubClient,
    ...(resolveRunInitiatorToken ? { resolveRunInitiatorToken } : {}),
    gitlabEngineClient,
    providerRegistry,
    resolveRepoTarget,
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
