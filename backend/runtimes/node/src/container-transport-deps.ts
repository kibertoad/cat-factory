import {
  type DeployJobClient,
  ProvisioningLogRecorder,
  type RunnerBackendRegistry,
} from '@cat-factory/integrations'
import type {
  AppCaches,
  Clock,
  DeployCloneTarget,
  GitHubClient,
  GitHubInstallationRepository,
  IdGenerator,
  RepoProjectionRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import {
  type AppConfig,
  type GitHubAppRegistry,
  type JobPackageRegistrySpec,
  type ResolveRepoOrigin,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
  RunnerJobClient,
  makeResolveDeployCloneTarget,
} from '@cat-factory/server'
import type { CoreDependencies } from '@cat-factory/orchestration'
import {
  buildNodeResolveTransport,
  selectNodeRepoBootstrapper,
  withProvisioningLog,
} from './container-executor-deps.js'
import type { DrizzleDb } from './db/client.js'
import { DrizzleBootstrapJobRepository } from './repositories/bootstrap.js'
import type { DrizzleRunnerPoolConnectionRepository } from './repositories/containerExecution.js'
import type { createDrizzleRepositories } from './repositories/drizzle.js'

type NodeRepositories = ReturnType<typeof createDrizzleRepositories>

/** Inputs {@link buildNodeTransportDeploy} needs from the composition root. */
export interface NodeTransportDeployInput {
  config: AppConfig
  repos: NodeRepositories
  idGenerator: IdGenerator
  clock: Clock
  runnerPoolConnectionRepository: DrizzleRunnerPoolConnectionRepository
  runnerBackendRegistry: RunnerBackendRegistry
  appRegistry: GitHubAppRegistry | undefined
  resolveRepoTarget: ResolveRepoTarget
  workspaceRepository: WorkspaceRepository
  /** Facade overrides (`resolveTransport`, the deploy seams) threaded from `NodeContainerOptions`. */
  resolveTransportOverride?: ResolveRunnerTransport | null
  runnerPoolProvider?: Parameters<typeof buildNodeResolveTransport>[5]
  skipProvisioningLogWrap?: boolean
  mintInstallationToken?: (installationId: number) => Promise<string>
  deployJobClientOverride?: DeployJobClient
  disableDefaultDeployJobClient?: boolean
  resolveDeployCloneTargetOverride?: (
    workspaceId: string,
    blockId: string,
    ref?: string,
  ) => Promise<DeployCloneTarget | null>
  resolveRepoOrigin?: ResolveRepoOrigin
}

/**
 * The runner-transport resolver + the container-backed deploy lifecycle seams of the Node
 * composition root, lifted out of `buildNodeContainer` so that root stays within the file-size
 * budget. Resolves the workspace's runner transport (a sibling facade's injected one wins, else
 * the self-hosted pool), wraps it with the provisioning-log decorator, and builds the deploy job
 * client + clone-target resolver (default: the pool-backed client + an App-token github.com origin).
 */
export function buildNodeTransportDeploy(input: NodeTransportDeployInput) {
  const {
    config,
    repos,
    idGenerator,
    clock,
    runnerPoolConnectionRepository,
    runnerBackendRegistry,
    appRegistry,
    resolveRepoTarget,
    workspaceRepository,
    resolveTransportOverride,
    runnerPoolProvider,
    skipProvisioningLogWrap,
    mintInstallationToken,
    deployJobClientOverride,
    disableDefaultDeployJobClient,
    resolveDeployCloneTargetOverride,
    resolveRepoOrigin,
  } = input

  // Best-effort recorder for the provisioning event log (its own Postgres schema).
  // Shared by the env services (via createCore) and the runner/container transport
  // decorator below, so every spin-up/down attempt is logged.
  const provisioningLogRecorder = new ProvisioningLogRecorder({
    repository: repos.provisioningLogRepository,
    idGenerator,
    clock,
  })

  // A sibling facade (local mode) may inject its own transport — even `null` — which
  // replaces the default self-hosted-pool resolution; undefined keeps Node's default
  // (a self-hosted pool, optionally driven by an injected native `runnerPoolProvider`).
  // The injected transport is a per-run container (local mode), the default is a
  // self-hosted pool — tag each accordingly so the logs drawer can filter by subsystem.
  // A facade that pre-wraps its branches with their own subsystem tags (local mode) sets
  // `skipProvisioningLogWrap` so we don't double-wrap.
  const baseResolveTransport =
    resolveTransportOverride !== undefined
      ? resolveTransportOverride
      : buildNodeResolveTransport(
          config,
          runnerPoolConnectionRepository,
          workspaceRepository,
          clock,
          runnerBackendRegistry,
          runnerPoolProvider,
        )
  const resolveTransport = skipProvisioningLogWrap
    ? baseResolveTransport
    : withProvisioningLog(
        baseResolveTransport,
        provisioningLogRecorder,
        resolveTransportOverride !== undefined ? 'container' : 'runner-pool',
      )

  // The async, container-backed Kubernetes deploy lifecycle (slice 9's `deployJobClient` +
  // `resolveDeployCloneTarget` seams). Node deploys on the workspace's self-hosted runner pool
  // (which pulls the `imageDeploy` variant), so the default deploy client wraps the SAME
  // `resolveTransport` the agent executor uses — the pool is Node's analogue of the Worker's
  // DeployContainer. The clone-target resolver mints a short-lived install token + a github.com
  // origin from the App registry. The local facade injects BOTH (a deploy-dedicated native/
  // container transport + a PAT/GitLab clone target) via `options`, which win here. Absent any
  // backend ⇒ unwired, so a render-needing config fails loudly (the raw REST path is unaffected).
  const baseDeployMint =
    mintInstallationToken ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  const deployJobClient: DeployJobClient | undefined =
    deployJobClientOverride ??
    (disableDefaultDeployJobClient || !resolveTransport
      ? undefined
      : new RunnerJobClient(resolveTransport))
  const resolveDeployCloneTarget =
    resolveDeployCloneTargetOverride ??
    (baseDeployMint
      ? makeResolveDeployCloneTarget(
          resolveRepoTarget,
          (id) => baseDeployMint(id),
          resolveRepoOrigin ? { resolveCloneUrl: (t) => resolveRepoOrigin(t).cloneUrl } : {},
        )
      : undefined)
  const deployDeps: Partial<CoreDependencies> = config.environments.encryptionKey
    ? {
        ...(deployJobClient ? { deployJobClient } : {}),
        ...(resolveDeployCloneTarget ? { resolveDeployCloneTarget } : {}),
      }
    : {}

  return { resolveTransport, baseDeployMint, deployDeps }
}

/** Inputs {@link buildNodeBootstrapper} needs from the composition root. */
export interface NodeBootstrapperInput {
  env: NodeJS.ProcessEnv
  config: AppConfig
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T
  resolveTransport: ResolveRunnerTransport | null
  githubInstallationRepository: GitHubInstallationRepository
  repoProjectionRepository: RepoProjectionRepository
  appRegistry: GitHubAppRegistry | undefined
  githubClient: GitHubClient | undefined
  mintInstallationToken?: (installationId: number) => Promise<string>
  resolvePackageRegistries?: (workspaceId: string) => Promise<JobPackageRegistrySpec[]>
  caches?: AppCaches
}

/**
 * The repo-bootstrap slice of the Node composition root (the reference-architecture library +
 * the container-dispatching `repoBootstrapper`), lifted out of `buildNodeContainer` so that root
 * stays within the file-size budget. The bootstrap-job repo is wired unconditionally (the module
 * + ref-arch CRUD then work like the Worker); the `repoBootstrapper` wires only when its
 * prerequisites are met (transport + proxy + token + GitHub client) — the same token source the
 * container executor uses.
 */
export function buildNodeBootstrapper(input: NodeBootstrapperInput) {
  const {
    env,
    config,
    sourced,
    resolveTransport,
    githubInstallationRepository,
    repoProjectionRepository,
    appRegistry,
    githubClient,
    mintInstallationToken,
    resolvePackageRegistries,
    caches,
  } = input

  const bootstrapJobRepository = sourced(
    'bootstrapJobRepository',
    (d) => new DrizzleBootstrapJobRepository(d),
  )
  const bootstrapMintInstallationToken =
    mintInstallationToken ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  const repoBootstrapper = selectNodeRepoBootstrapper({
    env,
    config,
    resolveTransport,
    installationRepository: githubInstallationRepository,
    bootstrapJobRepository,
    repoRepository: repoProjectionRepository,
    ...(caches?.repoProjection ? { repoProjectionCache: caches.repoProjection } : {}),
    githubClient,
    mintInstallationToken: bootstrapMintInstallationToken,
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
  })

  return { bootstrapJobRepository, bootstrapMintInstallationToken, repoBootstrapper }
}
