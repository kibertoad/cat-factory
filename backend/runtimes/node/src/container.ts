import { AiAgentExecutor } from '@cat-factory/agents'
import {
  HttpRunnerPoolProvider,
  RunnerPoolConnectionService,
  RunnerPoolTransport,
} from '@cat-factory/integrations'
import type {
  AgentExecutor,
  BlockRepository,
  Clock,
  GitHubInstallationRepository,
} from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import {
  type AppConfig,
  type ResolveRunnerTransport,
  type ServerContainer,
  CompositeAgentExecutor,
  ContainerAgentExecutor,
  ContainerSessionService,
  GitHubAppAuth,
  GitHubAppRegistry,
  WebCryptoSecretCipher,
  buildResolveRepoTarget,
} from '@cat-factory/server'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { createNodeModelProvider } from './modelProvider.js'
import {
  DrizzleGitHubInstallationRepository,
  DrizzleRepoProjectionRepository,
  DrizzleRunnerPoolConnectionRepository,
} from './repositories/containerExecution.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'

// HKDF domain tag separating runner-pool scheduler secrets from any other use of
// the same master key (mirrors the Worker's `cat-factory:runners`).
const RUNNERS_CIPHER_INFO = 'cat-factory:runners'

export interface NodeContainerOptions {
  /** The Drizzle/Postgres client (the single persistence layer). */
  db: DrizzleDb
  /**
   * Pre-built repositories; defaults to building them from {@link db}. Lets the caller
   * (e.g. {@link start}) share one set with the retention sweeper rather than rebuild.
   */
  repos?: ReturnType<typeof createDrizzleRepositories>
  /**
   * Started pg-boss instance for durable execution. When present the container wires
   * a {@link PgBossWorkRunner}; otherwise runs fall back to the engine's NoopWorkRunner
   * (the caller drives runs itself — e.g. tests).
   */
  boss?: PgBoss
  /** Pre-resolved config; defaults to `loadNodeConfig(env)`. */
  config?: AppConfig
  /** Environment source; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Override core dependencies — used by tests (e.g. a fake agent executor). */
  overrides?: Partial<CoreDependencies>
}

/**
 * Resolve which runner backend a workspace's container jobs dispatch to. The Node
 * facade has no built-in per-run container runtime (unlike the Worker's Cloudflare
 * Containers), so it serves a workspace's self-hosted runner pool when one is
 * registered and throws a clear error otherwise. Returns null (no transport at all)
 * when runner pools are not enabled. Mirrors the Worker's `buildResolveTransport`,
 * minus the Cloudflare-container path.
 */
function buildNodeResolveTransport(
  config: AppConfig,
  runnerPoolConnectionRepository: DrizzleRunnerPoolConnectionRepository,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  clock: Clock,
): ResolveRunnerTransport | null {
  if (!config.runners.enabled || !config.runners.encryptionKey) return null
  const runnerService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey,
      info: RUNNERS_CIPHER_INFO,
    }),
    clock,
  })
  const poolProvider = new HttpRunnerPoolProvider()
  return async (workspaceId) => {
    if (workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return new RunnerPoolTransport(poolProvider, resolved.manifest, resolved.resolveSecret)
      }
    }
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': the Node ` +
        `service runs repo-operating agents on a self-hosted runner pool — register one for ` +
        `this workspace (POST /workspaces/:id/runner-pools).`,
    )
  }
}

/**
 * Build the container agent executor (repo-operating steps: coder, mocker,
 * playwright, blueprints, ci-fixer, conflict-resolver, merger) when its
 * prerequisites are configured: the GitHub App (id + private key) to mint the push
 * token, the public URL backing the LLM proxy, the session secret to sign proxy
 * tokens, and a runner backend. Returns null when any is missing, so the composite
 * fails those kinds loudly rather than running them as useless one-shot LLM calls.
 */
function buildNodeContainerExecutor(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  db: DrizzleDb,
  clock: Clock,
  installationRepository: GitHubInstallationRepository,
  blockRepository: BlockRepository,
  resolveTransport: ResolveRunnerTransport | null,
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
  ) => Promise<string | undefined>,
): AgentExecutor | null {
  const privateKeyPem = env.GITHUB_APP_PRIVATE_KEY?.trim()
  // The harness reaches models only through this service's LLM proxy; `PUBLIC_URL`
  // is this service's externally reachable base (the runner pool must be able to
  // reach it). Pi posts to `${PUBLIC_URL}/v1/chat/completions`.
  const publicUrl = env.PUBLIC_URL?.trim()
  const sessionSecret = config.auth.sessionSecret

  if (
    !config.github.enabled ||
    !privateKeyPem ||
    !publicUrl ||
    !sessionSecret ||
    !resolveTransport
  ) {
    return null
  }

  const registry = new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: new GitHubAppAuth({
        appId: config.github.appId,
        privateKeyPem,
        installationRepository,
        clock,
        apiBase: config.github.apiBase,
      }),
    },
    installationRepository,
  })

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    resolveRepoTarget: buildResolveRepoTarget({
      installationRepository,
      repoProjectionRepository: new DrizzleRepoProjectionRepository(db),
      blockRepository,
    }),
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

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
 * App, `PUBLIC_URL`, `AUTH_SESSION_SECRET`, `RUNNERS_ENCRYPTION_KEY`) are absent the
 * composite still serves inline kinds but fails container kinds loudly.
 */
export function buildNodeContainer(options: NodeContainerOptions): ServerContainer {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  const repos = options.repos ?? createDrizzleRepositories(options.db, clock)

  // Honour the workspace's per-agent-kind defaults at run time (block-pinned >
  // workspace per-kind default > env routing), uniformly for inline and container kinds.
  const resolveWorkspaceModelDefault = (workspaceId: string, agentKind: string) =>
    repos.modelDefaultsRepository.getForKind(workspaceId, agentKind).then((v) => v ?? undefined)

  const inline = new AiAgentExecutor({
    modelProvider: createNodeModelProvider(env),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
  })

  // Persistence the container-execution path needs (built from the same db). The
  // runner-pool repo also backs the `runners` Core module so a pool is registrable
  // via the API; the installation repo backs both token minting and repo resolution.
  const runnerPoolConnectionRepository = new DrizzleRunnerPoolConnectionRepository(options.db)
  const githubInstallationRepository = new DrizzleGitHubInstallationRepository(options.db)

  const resolveTransport = buildNodeResolveTransport(
    config,
    runnerPoolConnectionRepository,
    repos.workspaceRepository,
    clock,
  )
  const container = buildNodeContainerExecutor(
    env,
    config,
    options.db,
    clock,
    githubInstallationRepository,
    repos.blockRepository,
    resolveTransport,
    resolveWorkspaceModelDefault,
  )

  // Always a composite: inline kinds run as one-shot LLM calls; repo-operating kinds
  // route to the container (and fail loudly when its prerequisites are unconfigured).
  const agentExecutor = new CompositeAgentExecutor(inline, container)

  const dependencies: CoreDependencies = {
    workspaceRepository: repos.workspaceRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    llmCallMetricRepository: repos.llmCallMetricRepository,
    modelDefaultsRepository: repos.modelDefaultsRepository,
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
    // The runner-pool integration assembles when enabled, so a workspace can
    // register the self-hosted pool its container agents dispatch to.
    ...(config.runners.enabled && config.runners.encryptionKey
      ? {
          runnerPoolConnectionRepository,
          runnerSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: config.runners.encryptionKey,
            info: RUNNERS_CIPHER_INFO,
          }),
        }
      : {}),
    ...(options.boss
      ? { workRunner: new PgBossWorkRunner(options.boss, executionRuntime(config, env).queue) }
      : {}),
    ...options.overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: repos.agentRunRepository,
    gateways: createNodeGateways(env),
  }
}
