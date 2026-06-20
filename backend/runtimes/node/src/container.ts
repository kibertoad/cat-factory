import { AiAgentExecutor } from '@cat-factory/agents'
import { TicketTrackerService } from '@cat-factory/integrations'
import type { TaskConnectionRepository, TaskSourceProvider } from '@cat-factory/kernel'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import type { AppConfig, ServerContainer } from '@cat-factory/server'
import type { PgBoss } from 'pg-boss'
import { loadNodeConfig } from './config.js'
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { createNodeModelProvider } from './modelProvider.js'
import { createDrizzleRepositories } from './repositories/drizzle.js'
import { DrizzleTaskConnectionRepository, DrizzleTaskRepository } from './repositories/tasks.js'
import { CryptoIdGenerator, SystemClock } from './runtime.js'
import { WebCryptoSecretCipher } from './secretCipher.js'
import { JiraProvider } from './tasks/JiraProvider.js'

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
 * The Node composition root: assemble the framework-agnostic domain `Core` with
 * Drizzle/Postgres repositories + Node implementations of the runtime ports, then
 * attach the shared-controller extras (`config`, the kind-spanning agent-run repo,
 * the runtime gateways). The same persistence is used in dev, test and prod — tests
 * run against a real Postgres, exactly as the Worker runs against a real D1.
 */
export function buildNodeContainer(options: NodeContainerOptions): ServerContainer {
  const env = options.env ?? process.env
  const config = options.config ?? loadNodeConfig(env)
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()
  const repos = options.repos ?? createDrizzleRepositories(options.db, clock)

  const agentExecutor = new AiAgentExecutor({
    modelProvider: createNodeModelProvider(env),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    // Honour the workspace's per-agent-kind defaults at run time (block-pinned >
    // workspace per-kind default > env routing). The Node facade runs every kind
    // inline, so without this the stored defaults would never take effect.
    resolveWorkspaceModelDefault: (workspaceId, agentKind) =>
      repos.modelDefaultsRepository.getForKind(workspaceId, agentKind).then((v) => v ?? undefined),
  })

  // Task-source integration (Jira). Opt-in via TASKS_ENABLED + TASKS_ENCRYPTION_KEY;
  // tenants connect their own Jira site through the UI and the credentials are stored
  // per-workspace, encrypted at rest. The tracker resolves each workspace's own
  // credentials from this same store (multi-tenant), mirroring the Cloudflare facade.
  const tasks = selectNodeTasksDeps(config, options.db)

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
    ...tasks.deps,
    // Recurring pipelines + the workspace tracker selection. The tracker provider
    // files the tech-debt pipeline's issue by resolving the *workspace's* connected
    // integration. Jira resolves per-workspace from the connection store above;
    // GitHub Issues need the per-tenant GitHub App installation infra (wired
    // separately, e.g. PR #66), so that tracker still passes through here.
    pipelineScheduleRepository: repos.pipelineScheduleRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    ticketTrackerProvider: new TicketTrackerService({
      trackerSettingsRepository: repos.trackerSettingsRepository,
      fetchImpl: fetch,
      ...(tasks.taskConnectionRepository
        ? {
            resolveJiraConnection: async (workspaceId) => {
              const connection = await tasks.taskConnectionRepository!.getByWorkspace(
                workspaceId,
                'jira',
              )
              const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
              if (!baseUrl || !accountEmail || !apiToken) return null
              return { baseUrl, accountEmail, apiToken }
            },
          }
        : {}),
    }),
    idGenerator,
    clock,
    agentExecutor,
    spendPricing: config.spend,
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

/**
 * Wire the task-source integration for the Node facade when it is enabled (the
 * `tasks` module then assembles so tenants can connect Jira through the existing
 * UI). Returns the `CoreDependencies` fragment plus the connection repository so the
 * tracker can resolve each workspace's Jira credentials from the same store.
 * Disabled → `{ deps: {} }` and both the tasks module and the Jira tracker stay off.
 */
function selectNodeTasksDeps(
  config: AppConfig,
  db: DrizzleDb,
): { deps: Partial<CoreDependencies>; taskConnectionRepository?: TaskConnectionRepository } {
  if (!config.tasks.enabled || !config.tasks.encryptionKey) return { deps: {} }
  const providers: TaskSourceProvider[] = []
  if (config.tasks.sources.includes('jira')) providers.push(new JiraProvider())
  if (providers.length === 0) return { deps: {} }

  const taskConnectionRepository = new DrizzleTaskConnectionRepository(
    db,
    // Source credentials are encrypted at rest under a tasks-scoped HKDF info (the
    // same domain the Cloudflare facade uses), keyed by TASKS_ENCRYPTION_KEY.
    new WebCryptoSecretCipher({ masterKeyBase64: config.tasks.encryptionKey, info: 'cat-factory:tasks' }),
  )
  return {
    deps: {
      taskSourceProviders: providers,
      taskConnectionRepository,
      taskRepository: new DrizzleTaskRepository(db),
    },
    taskConnectionRepository,
  }
}
