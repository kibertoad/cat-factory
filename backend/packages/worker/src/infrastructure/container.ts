import {
  type AgentExecutor,
  type Clock,
  type DocumentSourceProvider,
  type ExecutionEventPublisher,
  type FragmentOwnerKind,
  type IdGenerator,
  NoopWorkRunner,
  type TaskSourceProvider,
  type WorkRunner,
} from '@cat-factory/kernel'
import { AiAgentExecutor, resolveAgentConfig } from '@cat-factory/agents'
import { RunnerPoolConnectionService } from '@cat-factory/integrations'
import { type CoreDependencies, createCore } from '@cat-factory/orchestration'
import type { ServerContainer } from '@cat-factory/server'
import { type AppConfig, loadConfig } from './config'
import type { Env } from './env'
import { CloudflareModelProvider } from './ai/CloudflareModelProvider'
import { resolveExtraRegistries } from './ai/registries'
import { DoRealtimeGateway } from './gateways/DoRealtimeGateway'
import {
  ContainerAgentExecutor,
  type ResolveRepoTarget,
  type ResolveRunnerTransport,
} from './ai/ContainerAgentExecutor'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { ContainerInstanceRegistry } from './containers/ContainerInstanceRegistry'
import { D1LiveContainerRepository } from './repositories/D1LiveContainerRepository'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { RunnerPoolTransport } from './runners/RunnerPoolTransport'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { ContainerRepoBootstrapper } from './ai/ContainerRepoBootstrapper'
import { ContainerRepoScanner } from './ai/ContainerRepoScanner'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { DurableObjectEventPublisher } from './events/DurableObjectEventPublisher'
import { WorkflowsWorkRunner } from './workflows/WorkflowsWorkRunner'
import { WorkflowsBootstrapRunner } from './workflows/WorkflowsBootstrapRunner'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1AccountRepository } from './repositories/D1AccountRepository'
import { D1MembershipRepository } from './repositories/D1MembershipRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1BranchProjectionRepository } from './repositories/D1BranchProjectionRepository'
import { D1PullRequestProjectionRepository } from './repositories/D1PullRequestProjectionRepository'
import { D1IssueProjectionRepository } from './repositories/D1IssueProjectionRepository'
import { D1CommitProjectionRepository } from './repositories/D1CommitProjectionRepository'
import { D1CheckRunProjectionRepository } from './repositories/D1CheckRunProjectionRepository'
import { D1RateLimitRepository } from './repositories/D1RateLimitRepository'
import { D1DocumentConnectionRepository } from './repositories/D1DocumentConnectionRepository'
import { D1DocumentRepository } from './repositories/D1DocumentRepository'
import { D1EnvironmentConnectionRepository } from './repositories/D1EnvironmentConnectionRepository'
import { D1EnvironmentRegistryRepository } from './repositories/D1EnvironmentRegistryRepository'
import { D1ReferenceArchitectureRepository } from './repositories/D1ReferenceArchitectureRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { D1AgentRunRepository } from './repositories/D1AgentRunRepository'
import { D1RepoBlueprintRepository } from './repositories/D1RepoBlueprintRepository'
import { D1RequirementReviewRepository } from './repositories/D1RequirementReviewRepository'
import { D1NotificationRepository } from './repositories/D1NotificationRepository'
import { D1MergePresetRepository } from './repositories/D1MergePresetRepository'
import { InAppNotificationChannel } from './events/InAppNotificationChannel'
import { GitHubCiStatusProvider } from './github/GitHubCiStatusProvider'
import { GitHubMergeabilityProvider } from './github/GitHubMergeabilityProvider'
import { GitHubPullRequestMerger } from './github/GitHubPullRequestMerger'
import { HttpEnvironmentProvider } from './environments/HttpEnvironmentProvider'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { GitHubAppAuth } from './github/GitHubAppAuth'
import { GitHubAppRegistry } from './github/GitHubAppRegistry'
import { FetchGitHubClient } from './github/FetchGitHubClient'
import { FetchGitHubProvisioningClient } from './github/FetchGitHubProvisioningClient'
import { WebCryptoWebhookVerifier } from './github/WebCryptoWebhookVerifier'
import { ConfluenceProvider } from './documents/ConfluenceProvider'
import { NotionProvider } from './documents/NotionProvider'
import { JiraProvider } from './tasks/JiraProvider'
import { GitHubIssuesProvider } from './tasks/GitHubIssuesProvider'
import { D1TaskConnectionRepository } from './repositories/D1TaskConnectionRepository'
import { D1TaskRepository } from './repositories/D1TaskRepository'
import { D1PromptFragmentRepository } from './repositories/D1PromptFragmentRepository'
import { D1FragmentSourceRepository } from './repositories/D1FragmentSourceRepository'
import { LlmFragmentSelector } from './ai/LlmFragmentSelector'
import { CryptoIdGenerator, SystemClock } from './runtime'
import type { D1Database } from '@cloudflare/workers-types'

// The infrastructure composition root: turn a Worker `env` into the concrete
// ports (D1 repositories, runtime, the chosen agent executor) and assemble the
// domain core. Built once per request — instantiation is cheap and each request
// gets its own D1 handle from `env`.

// The Worker's container shape is exactly the shared one (domain Core + resolved
// config + the kind-spanning agent-run repository); the type lives in the shared
// package so the cross-runtime controllers can reference it.
export type Container = ServerContainer

/**
 * The Worker's {@link ModelProvider}: the base registry plus any extra provider
 * registries an installation registered (see ./ai/registries). Used everywhere a
 * model provider is needed so every path — agent executor, requirements reviewer,
 * doc planner, fragment selector — sees the same provider set.
 */
function buildModelProvider(env: Env): CloudflareModelProvider {
  return new CloudflareModelProvider({ env, extraRegistries: resolveExtraRegistries(env) })
}

/**
 * Pick the agent that performs pipeline steps: real LLM work via the Vercel AI
 * SDK, composed with a per-run sandbox for the repo-operating steps (`coder`,
 * `mocker`, `playwright`, …). Container-based implementation is ALWAYS on — the
 * sandbox is a hard requirement, so this throws at startup if it can't be built.
 * Tests bypass this entirely by overriding `agentExecutor` with a fake.
 *
 * There is intentionally NO inline fallback for the sandbox kinds — a one-shot
 * LLM call cannot clone/edit/commit/open a PR, so a degraded inline implementer is
 * silently broken rather than usefully degraded. If the sandbox prerequisites are
 * missing we fail the deploy loudly here rather than starting with a half-wired
 * implementer that would only fault the moment a repo-operating step is dispatched.
 */
function selectAgentExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  resolveTransport: ResolveRunnerTransport | null,
): AgentExecutor {
  const inline = new AiAgentExecutor({
    modelProvider: buildModelProvider(env),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
  })

  // The sandbox MUST build — a null here means a prerequisite (GitHub App private
  // key, WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, or a runner backend: the
  // EXEC_CONTAINER binding or a registered runner pool) is missing. We refuse to
  // start with a half-configured implementer rather than quietly running the
  // repo-operating steps as useless one-shot LLM calls.
  const container = buildContainerExecutor(env, config, db, clock, resolveTransport)
  if (!container) {
    throw new Error(
      'Container-based implementation is required but its prerequisites are missing. ' +
        'Required: a configured GitHub App (GITHUB_APP_PRIVATE_KEY), WORKER_PUBLIC_URL, ' +
        'AUTH_SESSION_SECRET, and a runner backend (the EXEC_CONTAINER binding or a ' +
        'registered runner pool with RUNNERS_ENABLED). Refusing to start with a broken ' +
        'executor instead of silently degrading to one-shot LLM calls.',
    )
  }

  // Always the composite: non-sandbox kinds run inline; sandbox kinds run in the
  // container.
  return new CompositeAgentExecutor(inline, container)
}

/**
 * Build the factory that picks a job's runner backend: a workspace's own
 * self-hosted runner pool when one is registered (and runner pools are enabled),
 * otherwise the per-run Cloudflare Container. Returns null when neither backend is
 * available, so {@link buildContainerExecutor} falls back to inline work.
 */
function buildResolveTransport(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ResolveRunnerTransport | null {
  // The Cloudflare backend folds in instance-level reaping: the registry records
  // each dispatched container in the live inventory and clears it on release, so the
  // cron reaper (index.ts) can kill anything that outlived its lifetime — covering
  // run/blueprint/bootstrap through this one transport with no per-flow wiring.
  const cloudflare = env.EXEC_CONTAINER
    ? new CloudflareContainerTransport(
        env.EXEC_CONTAINER,
        new ContainerInstanceRegistry(
          env.EXEC_CONTAINER,
          new D1LiveContainerRepository({ db }),
          clock,
        ),
      )
    : null

  // The self-hosted pool path: one stateless manifest interpreter (its OAuth cache
  // shared) plus a connection service to resolve each workspace's manifest+secrets.
  let runnerService: RunnerPoolConnectionService | undefined
  let poolProvider: HttpRunnerPoolProvider | undefined
  if (config.runners.enabled) {
    runnerService = new RunnerPoolConnectionService({
      runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
      workspaceRepository: new D1WorkspaceRepository({ db }),
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.runners.encryptionKey!,
        info: 'cat-factory:runners',
      }),
      clock,
    })
    poolProvider = new HttpRunnerPoolProvider()
  }

  if (!cloudflare && !runnerService) return null

  return async (workspaceId) => {
    if (runnerService && poolProvider && workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return new RunnerPoolTransport(poolProvider, resolved.manifest, resolved.resolveSecret)
      }
    }
    if (cloudflare) return cloudflare
    throw new Error(
      `No runner backend available for workspace '${workspaceId ?? '(unknown)'}': ` +
        `register a runner pool or enable Cloudflare Containers`,
    )
  }
}

/**
 * Build the container-based implementation executor, or return null when its
 * prerequisites are missing (a runner backend — Cloudflare Containers and/or a
 * self-hosted pool — plus a configured GitHub App, the proxy's public URL and the
 * signing secret) — the caller then falls back to inline work.
 */
/**
 * Build the multi-App registry (ADR 0005): the default App always, plus the
 * privileged App when configured. It resolves which App's key to use per
 * installation (from the binding's recorded appId), so every token mint / app-JWT
 * call routes correctly. Callers guard on `config.github.enabled`, which requires
 * GITHUB_APP_PRIVATE_KEY, so the default key is present.
 */
function buildAppRegistry(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): GitHubAppRegistry {
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const makeAuth = (appId: string, privateKeyPem: string) =>
    new GitHubAppAuth({
      appId,
      privateKeyPem,
      installationRepository,
      clock,
      apiBase: config.github.apiBase,
    })
  const privileged =
    config.github.privilegedApp && env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY
      ? {
          appId: config.github.privilegedApp.appId,
          auth: makeAuth(config.github.privilegedApp.appId, env.GITHUB_PRIVILEGED_APP_PRIVATE_KEY),
        }
      : undefined
  return new GitHubAppRegistry({
    default: {
      appId: config.github.appId,
      auth: makeAuth(config.github.appId, env.GITHUB_APP_PRIVATE_KEY!),
    },
    privileged,
    installationRepository,
  })
}

/**
 * Resolve the repo linked to a running block's enclosing service. Repos are
 * linked at the service-frame level (see `linkBlock`), but execution runs at the
 * task/module level, so we walk up the block's ancestry to find the frame's repo.
 * There is deliberately NO "first repo" fallback: a workspace can have many repos,
 * and guessing silently pushes work into the wrong one (this is how a simple-service
 * task ended up force-pushing to butter-spread). If nothing in the chain is linked
 * we throw so the misconfiguration surfaces instead of corrupting another repo.
 * Shared by the container executor, the CI status provider and the PR merger.
 */
function buildResolveRepoTarget(db: D1Database): ResolveRepoTarget {
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const repoRepository = new D1RepoProjectionRepository({ db })
  const blockRepository = new D1BlockRepository({ db })
  return async (workspaceId, blockId) => {
    const installation = await installationRepository.getByWorkspace(workspaceId)
    if (!installation) return null
    const repos = await repoRepository.list(workspaceId)
    if (repos.length === 0) return null
    const linkedIds = new Set(repos.map((r) => r.blockId).filter((id): id is string => !!id))

    let linkedBlockId: string | undefined
    let cursor: string | null = blockId
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      if (linkedIds.has(cursor)) {
        linkedBlockId = cursor
        break
      }
      seen.add(cursor)
      const block = await blockRepository.get(workspaceId, cursor)
      cursor = block?.parentId ?? null
    }

    const repo = repos.find((r) => r.blockId === linkedBlockId)
    if (!repo) {
      throw new Error(
        `Block '${blockId}' is not under a service linked to a GitHub repository ` +
          `(workspace '${workspaceId}'). Link the service frame to its repo so execution ` +
          `targets the right repository instead of guessing one.`,
      )
    }
    return {
      installationId: installation.installationId,
      owner: repo.owner,
      name: repo.name,
      baseBranch: repo.defaultBranch ?? 'main',
    }
  }
}

/**
 * Build the merge-lifecycle ports. The notification repository + merge-preset
 * repository are wired unconditionally (the inbox + presets are always available);
 * the in-app delivery channel is wired only when the events binding is present
 * (else rows persist but nothing is pushed). The CI status provider + PR merger
 * need GitHub, so they're wired only when the App is configured — without them the
 * `ci` gate passes through and `done` is a board-only flip (graceful degradation).
 */
function selectMergeLifecycleDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    notificationRepository: new D1NotificationRepository({ db }),
    mergePresetRepository: new D1MergePresetRepository({ db }),
  }
  const publisher = selectEventPublisher(env)
  if (publisher) deps.notificationChannel = new InAppNotificationChannel(publisher)

  if (config.github.enabled && env.GITHUB_APP_PRIVATE_KEY) {
    const registry = buildAppRegistry(env, config, db, clock)
    const githubClient = new FetchGitHubClient({
      registry,
      rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
      idGenerator,
      clock,
      apiBase: config.github.apiBase,
    })
    const resolveRepoTarget = buildResolveRepoTarget(db)
    const blockRepository = new D1BlockRepository({ db })
    deps.ciStatusProvider = new GitHubCiStatusProvider({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    deps.mergeabilityProvider = new GitHubMergeabilityProvider({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
    deps.pullRequestMerger = new GitHubPullRequestMerger({
      githubClient,
      resolveRepoTarget,
      blockRepository,
    })
  }
  return deps
}

function buildContainerExecutor(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  resolveTransport: ResolveRunnerTransport | null,
): AgentExecutor | null {
  if (
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return null
  }

  if (!resolveTransport) return null

  const registry = buildAppRegistry(env, config, db, clock)
  const resolveRepoTarget = buildResolveRepoTarget(db)

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveRepoTarget,
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Pick how runs are driven:
 *   - a Workflows binding present → durable, server-driven execution
 *   - otherwise                   → no-op (e.g. tests, which override this anyway)
 * Tests override `workRunner` with a fake and drive the engine via advanceInstance.
 */
function selectWorkRunner(env: Env): WorkRunner {
  if (env.EXECUTION_WORKFLOW) {
    return new WorkflowsWorkRunner({
      workflow: env.EXECUTION_WORKFLOW,
      queue: env.EXECUTION_QUEUE,
    })
  }
  return new NoopWorkRunner()
}

/**
 * Pick how execution/board changes are pushed to clients:
 *   - WORKSPACE_EVENTS binding present → fan out via the per-workspace hub DO
 *   - otherwise                        → undefined (core falls back to a no-op)
 * Tests leave the binding unset; the engine simply pushes nothing.
 */
function selectEventPublisher(env: Env): ExecutionEventPublisher | undefined {
  if (!env.WORKSPACE_EVENTS) return undefined
  return new DurableObjectEventPublisher(env.WORKSPACE_EVENTS)
}

/**
 * Build the GitHub integration's concrete ports when an App is configured,
 * mirroring `selectWorkRunner`. Returns an empty object otherwise, so `createCore`
 * leaves the `github` module unassembled and the feature stays opt-in.
 */
function selectGitHubDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  if (!config.github.enabled) return {}

  const githubInstallationRepository = new D1GitHubInstallationRepository({ db })
  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })
  // Privileged App tier (ADR 0005): when configured, its client backs the
  // create-repo endpoint; `canCreateRepos` flags a connection whose installation
  // is owned by the privileged App. Absent → repo creation stays the manual flow.
  const repoProvisioningClient = config.github.privilegedApp
    ? new FetchGitHubProvisioningClient({ registry, apiBase: config.github.apiBase })
    : undefined
  return {
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository: new D1RepoProjectionRepository({ db }),
    branchProjectionRepository: new D1BranchProjectionRepository({ db }),
    pullRequestProjectionRepository: new D1PullRequestProjectionRepository({ db }),
    issueProjectionRepository: new D1IssueProjectionRepository({ db }),
    commitProjectionRepository: new D1CommitProjectionRepository({ db }),
    checkRunProjectionRepository: new D1CheckRunProjectionRepository({ db }),
    webhookVerifier: new WebCryptoWebhookVerifier(env.GITHUB_WEBHOOK_SECRET!),
    // Bound the initial backfill to the commit retention horizon (0 = full).
    commitBackfillHorizonMs: config.retention.commitMs || undefined,
    repoProvisioningClient,
    canCreateRepos: (installation) => registry.canCreateRepos(installation),
    // Advisory: does the install actually grant `workflows: write`? Read from the
    // owning App's installation-token permission set (cached), so the UI can warn
    // when agent pushes touching `.github/workflows/*` would be rejected.
    workflowsGranted: async (installation) => {
      const perms = await registry.installationPermissions(installation.installationId)
      return perms.workflows === 'write'
    },
  }
}

/**
 * Build the document-source integration's concrete ports when opted in: the
 * configured source providers (Confluence, Notion, …) plus the two D1
 * repositories. The model provider is wired only in 'llm' planner mode (it just
 * needs a provider credential); the planner degrades to its deterministic parser
 * if no model is usable. Returns `{}` when disabled, so `createCore` leaves the
 * `documents` module unassembled.
 */
function selectDocumentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.documents.enabled) return {}
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  if (providers.length === 0) return {}
  return {
    documentSourceProviders: providers,
    documentConnectionRepository: new D1DocumentConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a documents-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey!,
        info: 'cat-factory:documents',
      }),
    }),
    documentRepository: new D1DocumentRepository({ db }),
    ...(config.documents.planner === 'llm'
      ? {
          modelProvider: buildModelProvider(env),
          documentPlannerModel: config.agents.routing.default.ref,
        }
      : {}),
  }
}

/**
 * Build the task-source integration's concrete ports when opted in. Mirrors
 * `selectDocumentsDeps` but with no planner — issues are linked for context, not
 * expanded into board structure. Returns `{}` when disabled, so `createCore`
 * leaves the `tasks` module unassembled.
 */
function selectTasksDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
): Partial<CoreDependencies> {
  if (!config.tasks.enabled) return {}
  const providers: TaskSourceProvider[] = []
  if (config.tasks.sources.includes('jira')) providers.push(new JiraProvider())
  // GitHub issues reuse the workspace's installed GitHub App, so this provider
  // is wired only when the GitHub integration is also configured — it has no
  // credentials of its own and resolves the installation per issue.
  if (config.tasks.sources.includes('github') && config.github.enabled) {
    const registry = buildAppRegistry(env, config, db, clock)
    providers.push(
      new GitHubIssuesProvider({
        githubClient: new FetchGitHubClient({
          registry,
          rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
          idGenerator,
          clock,
          apiBase: config.github.apiBase,
        }),
        installations: new D1GitHubInstallationRepository({ db }),
      }),
    )
  }
  if (providers.length === 0) return {}
  return {
    taskSourceProviders: providers,
    taskConnectionRepository: new D1TaskConnectionRepository({
      db,
      // The config gate guarantees the key is present when enabled; source
      // credentials are encrypted at rest under a tasks-scoped HKDF info.
      cipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.tasks.encryptionKey!,
        info: 'cat-factory:tasks',
      }),
    }),
    taskRepository: new D1TaskRepository({ db }),
  }
}

/**
 * Wire the requirements-review feature. The repository is always available, and a
 * model provider + the agents' default ref are supplied so the stateless reviewer
 * works whenever an LLM is configured — independent of the documents integration.
 * (Supplying the provider here is harmless when documents are off or set to the
 * heading-based planner: that planner only engages when `documentPlannerModel` is
 * also set, which this does not touch.)
 */
function selectRequirementsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  return {
    requirementReviewRepository: new D1RequirementReviewRepository({ db }),
    modelProvider: buildModelProvider(env),
    // The routing default already resolves to Cloudflare Workers AI unless a
    // direct provider key is set, so the reviewer runs on Cloudflare by default.
    requirementReviewModel: config.agents.routing.default.ref,
    // Honour a block's pinned model with the same direct/Cloudflare fallback the
    // agent executor (and the Pi container path) use.
    requirementReviewResolveModel: config.agents.resolveBlockModel,
  }
}

/**
 * Build the ephemeral environment integration's concrete ports when opted in.
 * Requires the encryption key (the config gate already enforces this), so the
 * generic HTTP provider, the D1 repositories and the Web Crypto cipher are wired
 * together. Returns `{}` when disabled, so `createCore` leaves the `environments`
 * module unassembled and the deterministic deployer / env discovery stay off.
 */
function selectEnvironmentsDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.environments.enabled) return {}
  return {
    environmentProvider: new HttpEnvironmentProvider(),
    environmentConnectionRepository: new D1EnvironmentConnectionRepository({ db }),
    environmentRegistryRepository: new D1EnvironmentRegistryRepository({ db }),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey!,
    }),
  }
}

/**
 * Build the self-hosted runner-pool integration's concrete ports when opted in:
 * the D1 connection repository and a dedicated Web Crypto cipher (its own master
 * key + HKDF domain, separate from the environment module's). This assembles
 * `Core.runners` (the connection-management API); the per-job transport selection
 * lives in `buildResolveTransport` above. Returns `{}` when disabled.
 */
function selectRunnersDeps(env: Env, config: AppConfig, db: D1Database): Partial<CoreDependencies> {
  if (!config.runners.enabled) return {}
  return {
    runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
    runnerSecretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey!,
      info: 'cat-factory:runners',
    }),
  }
}

/**
 * Build the container-backed repo bootstrapper for the "bootstrap repo" task,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving reference-architecture CRUD available while the run
 * path reports itself unavailable.
 */
function selectRepoBootstrapper(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
  idGenerator: IdGenerator,
  resolveTransport: ResolveRunnerTransport | null,
): ContainerRepoBootstrapper | undefined {
  if (
    !resolveTransport ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const registry = buildAppRegistry(env, config, db, clock)
  const githubClient = new FetchGitHubClient({
    registry,
    rateLimitRepository: new D1RateLimitRepository({ db, idGenerator }),
    idGenerator,
    clock,
    apiBase: config.github.apiBase,
  })

  return new ContainerRepoBootstrapper({
    resolveTransport,
    installationRepository,
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoRepository: new D1RepoProjectionRepository({ db }),
    githubClient,
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // Bootstrap is an `architect`-kind run, so it follows that kind's routing
    // (GLM-5.2 by default) rather than the global default.
    model: resolveAgentConfig(config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Build the container-backed repo scanner for the "scan repository" command,
 * gated on the same prerequisites as the implementation container (the binding, a
 * configured GitHub App, the proxy's public URL and signing secret). Returns
 * undefined otherwise, leaving blueprint reads available while the scan path
 * reports itself unavailable.
 */
function selectRepoScanner(
  env: Env,
  config: AppConfig,
  db: D1Database,
  clock: Clock,
): ContainerRepoScanner | undefined {
  if (
    !env.EXEC_CONTAINER ||
    !config.github.enabled ||
    !env.GITHUB_APP_PRIVATE_KEY ||
    !env.WORKER_PUBLIC_URL ||
    !env.AUTH_SESSION_SECRET
  ) {
    return undefined
  }

  const installationRepository = new D1GitHubInstallationRepository({ db })
  const registry = buildAppRegistry(env, config, db, clock)

  return new ContainerRepoScanner({
    container: env.EXEC_CONTAINER,
    installationRepository,
    mintInstallationToken: (id) => registry.installationToken(id),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // Repo scanning is also an `architect`-kind run — follow that kind's routing.
    model: resolveAgentConfig(config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    githubApiBase: config.github.apiBase,
  })
}

/**
 * Build the prompt-fragment library's concrete ports when opted in (ADR 0006):
 * the two D1 repositories, the relevance selector (LLM when configured, else the
 * core deterministic matcher via `fragmentSelector: undefined`), and the
 * installation resolver repo-source sync uses to read guideline repos through the
 * tier's GitHub installation. Returns `{}` when disabled, so `createCore` leaves
 * the `fragmentLibrary` module unassembled and the engine uses manual fragmentIds.
 */
function selectFragmentLibraryDeps(
  env: Env,
  config: AppConfig,
  db: D1Database,
): Partial<CoreDependencies> {
  if (!config.fragmentLibrary.enabled) return {}
  const installationRepository = new D1GitHubInstallationRepository({ db })
  const resolveFragmentInstallationId = async (
    ownerKind: FragmentOwnerKind,
    ownerId: string,
  ): Promise<number | null> => {
    if (ownerKind === 'workspace') {
      return (await installationRepository.getByWorkspace(ownerId))?.installationId ?? null
    }
    // Account scope: the installation bound to this account (migration 0017).
    const active = await installationRepository.listActive()
    return active.find((i) => i.accountId === ownerId)?.installationId ?? null
  }
  return {
    promptFragmentRepository: new D1PromptFragmentRepository({ db }),
    fragmentSourceRepository: new D1FragmentSourceRepository({ db }),
    resolveFragmentInstallationId,
    ...(config.fragmentLibrary.selector === 'llm'
      ? {
          fragmentSelector: new LlmFragmentSelector({
            modelProvider: buildModelProvider(env),
            modelRef: config.agents.routing.default.ref,
          }),
        }
      : {}),
  }
}

export function buildContainer(env: Env, overrides: Partial<CoreDependencies> = {}): Container {
  const config = loadConfig(env)
  const db = env.DB
  const clock = new SystemClock()
  const idGenerator = new CryptoIdGenerator()

  // The runner-backend factory is shared by every container-backed flow (the
  // implementation executor and the repo bootstrapper), so both dispatch through the
  // same Cloudflare/self-hosted seam — and the bootstrapper rides the reaping-aware
  // Cloudflare transport for free. Null when no backend is configured.
  const resolveTransport = buildResolveTransport(env, config, db, clock)

  const dependencies: CoreDependencies = {
    workspaceRepository: new D1WorkspaceRepository({ db }),
    accountRepository: new D1AccountRepository({ db }),
    membershipRepository: new D1MembershipRepository({ db }),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    idGenerator,
    clock,
    // When a caller injects its own agentExecutor (tests pass a FakeAgentExecutor)
    // skip selection entirely — selectAgentExecutor throws when a sandbox is opted
    // in but its prerequisites are missing, which is the desired loud failure in
    // production but must not fire for tests that never reach the real executor.
    agentExecutor:
      overrides.agentExecutor ?? selectAgentExecutor(env, config, db, clock, resolveTransport),
    workRunner: selectWorkRunner(env),
    executionEventPublisher: selectEventPublisher(env),
    spendPricing: config.spend,
    // Repo-bootstrap repositories are wired unconditionally (reference-architecture
    // CRUD is always available); the run path additionally needs the bootstrapper.
    referenceArchitectureRepository: new D1ReferenceArchitectureRepository({ db }),
    bootstrapJobRepository: new D1BootstrapJobRepository({ db }),
    repoBootstrapper: selectRepoBootstrapper(env, config, db, clock, idGenerator, resolveTransport),
    // Durably drive each bootstrap run's poll loop when the Workflows binding is
    // present (mirrors the execution driver); without it a run still dispatches.
    bootstrapRunner: env.BOOTSTRAP_WORKFLOW
      ? new WorkflowsBootstrapRunner(env.BOOTSTRAP_WORKFLOW)
      : undefined,
    // Board-scan: the blueprint repository is wired unconditionally (reads are
    // always available); the scan path additionally needs the container scanner.
    repoBlueprintRepository: new D1RepoBlueprintRepository({ db }),
    repoScanner: selectRepoScanner(env, config, db, clock),
    ...selectGitHubDeps(env, config, db, clock, idGenerator),
    ...selectMergeLifecycleDeps(env, config, db, clock, idGenerator),
    ...selectDocumentsDeps(env, config, db),
    ...selectTasksDeps(env, config, db, clock, idGenerator),
    ...selectRequirementsDeps(env, config, db),
    ...selectEnvironmentsDeps(env, config, db),
    ...selectRunnersDeps(env, config, db),
    ...selectFragmentLibraryDeps(env, config, db),
    ...overrides,
  }

  return {
    ...createCore(dependencies),
    config,
    agentRunRepository: new D1AgentRunRepository({ db }),
    gateways: {
      // Real-time event delivery via the per-workspace WorkspaceEventsHub DO (when
      // the WORKSPACE_EVENTS namespace is bound; absent → the events route 501s).
      realtime: new DoRealtimeGateway(env.WORKSPACE_EVENTS),
    },
  }
}
