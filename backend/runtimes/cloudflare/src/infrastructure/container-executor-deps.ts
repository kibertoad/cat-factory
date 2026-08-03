// The Worker's AGENT-EXECUTOR wiring: which backend runs a job (`buildResolveTransport` — a
// workspace's own self-hosted runner pool, else the per-run Cloudflare Container), the container
// executor built on it, the composite that routes inline vs. sandbox kinds, and the optional
// consensus wrap around the result.
//
// Split out of `container.ts` along the seam the Node facade already draws with
// `container-executor-deps.ts`, so the composition root holds the spine and the per-concern
// `select*Deps` selectors rather than the executor's own backend selection. Model resolution is
// imported from `container-model-resolver.ts` rather than from the root, so the graph is acyclic.

import {
  type AgentContextRecorder,
  type AgentExecutor,
  type Clock,
  type ExecutionEventPublisher,
  type ProvisioningSubsystem,
  type RunnerPoolProvider,
  type RunnerTransport,
  type ToolSecretResolver,
  type WebSearchAvailability,
} from '@cat-factory/kernel'
import {
  AiAgentExecutor,
  type AgentKindRegistry,
  inlineWebSearchOptionsFromEnv,
} from '@cat-factory/agents'
import {
  type RunnerBackendRegistry,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  RunnerPoolConnectionService,
  ProvisioningLogRecorder,
  LoggingRunnerTransport,
  RegistrySubscriptionQuotaProvider,
  defaultSubscriptionQuotaRegistry,
} from '@cat-factory/integrations'
import { buildTraceSink } from './container-trace-sinks.js'
import { LlmObservabilityService, makeHarnessCallRecorder } from '@cat-factory/orchestration'
import {
  ensureWorkBranchViaRest,
  logger,
  createDefaultWebSearchUpstream,
  createWebSearchUpstream,
  ENV_HELP,
  configProblem,
  resolveUrlSafetyPolicy,
  noRunnerBackendAvailableError,
  type MintInstallationToken,
  type WebSearchUpstream,
  createEnvToolSecretResolver,
  operationalMetrics,
} from '@cat-factory/server'
import { type AppConfig } from './config'
import type { Env } from './env'
import { requireTelemetryDb } from './env'
import { ContainerAgentExecutor, type ResolveRunnerTransport } from './ai/ContainerAgentExecutor'
import type { AccountSettingsService } from '@cat-factory/integrations'
import type { JobPackageRegistrySpec } from '@cat-factory/server'
import { CloudflareContainerTransport } from './containers/CloudflareContainerTransport'
import { ContainerInstanceRegistry } from './containers/ContainerInstanceRegistry'
import { D1LiveContainerRepository } from './repositories/D1LiveContainerRepository'
import { HttpRunnerPoolProvider } from './runners/HttpRunnerPoolProvider'
import { D1RunnerPoolConnectionRepository } from './repositories/D1RunnerPoolConnectionRepository'
import { CompositeAgentExecutor } from './ai/CompositeAgentExecutor'
import { ContainerSessionService } from './containers/ContainerSessionService'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import { D1ConsensusSessionRepository } from './repositories/D1ConsensusSessionRepository'
import { ConsensusAgentExecutor, registerConsensusTraits } from '@cat-factory/consensus'
import { D1WorkspaceSettingsRepository } from './repositories/D1WorkspaceSettingsRepository'
import { D1SubscriptionQuotaCycleRepository } from './repositories/D1SubscriptionQuotaCycleRepository'
import { WebCryptoSecretCipher } from './environments/WebCryptoSecretCipher'
import { buildTestSecretsService } from './wireCredentialServices'
import { CryptoIdGenerator } from './runtime'
import type { D1Database } from '@cloudflare/workers-types'
import {
  buildModelProviderResolver,
  buildResolveWorkspaceModelDefault,
} from './container-model-resolver.js'
import {
  buildAppRegistry,
  buildResolveRepoTarget,
  buildResolveRepoTargets,
  buildResolveRunInitiatorToken,
} from './container-vcs-identity.js'

/**
 * The shared prerequisites both the composite executor selection and its container leg
 * need — the Worker's infra handles (`env`/`config`/`db`/`clock`), the resolved runner
 * transport, the agent-kind registry, and the optional subscription / observability seams.
 * Bundled so the two builders take one dependency object rather than nine positional args.
 */
export interface WorkerExecutorDeps {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  resolveTransport: ResolveRunnerTransport | null
  agentKindRegistry: AgentKindRegistry
  subscriptions?: ProviderSubscriptionService
  personalSubscriptions?: PersonalSubscriptionService
  agentContextObservability?: AgentContextRecorder
  /**
   * Resolve a workspace's private package registries onto a container job, so the checkout can
   * install private dependencies. Passed in rather than built here: the builder is the
   * composition root's, and the root imports THIS module — so taking it as a dependency is what
   * keeps the graph one-way.
   */
  resolvePackageRegistries: ((workspaceId: string) => Promise<JobPackageRegistrySpec[]>) | undefined
  /**
   * The account-settings reader used ONLY to answer "does this run's account have web-search
   * keys of its own". A DEDICATED instance with no `settingsCache`: the `accountSettings` slice
   * is pass-through on the Worker's isolate-safe profile, so caching it here would be a no-op,
   * and the primary instance (whose decrypted view drives the runtime resolvers) is the one that
   * gets the shared slice. Undefined when account settings aren't wired.
   */
  webSearchAccountSettings: AccountSettingsService | undefined
  /**
   * Resolve the credentials a registered capability declared — a tool server's (MCP) and a
   * generative binary integration's alike. Absent ⇒ the deployment-environment default over the
   * Worker's own configured vars.
   *
   * Passed in for the same reason `resolvePackageRegistries` is: it is the composition root's to
   * decide, and a deployment holding PER-WORKSPACE credentials replaces it wholesale
   * (`createWorker({ createToolSecretResolver })`). Until it existed, `ToolSecretResolver` was a
   * port with exactly one reachable implementation — the one this module hard-coded.
   */
  resolveToolSecrets?: ToolSecretResolver
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
export function selectAgentExecutor(deps: WorkerExecutorDeps): AgentExecutor {
  const { env, config, db, agentKindRegistry } = deps
  const inline = new AiAgentExecutor({
    modelProviderResolver: buildModelProviderResolver(env, db),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    // Inline (non-sandbox) kinds honour the workspace's per-kind defaults too, so
    // the resolution precedence is uniform across every agent kind, not just the
    // container kinds.
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    // Opt-in provider web search for the inline design/research kinds (no-op unless
    // INLINE_WEB_SEARCH_ENABLED and an Anthropic/OpenAI model).
    webSearch: inlineWebSearchOptionsFromEnv(env),
    agentKindRegistry,
  })

  // The sandbox MUST build — a null here means a prerequisite (GitHub App private
  // key, WORKER_PUBLIC_URL, AUTH_SESSION_SECRET, or a runner backend: the
  // EXEC_CONTAINER binding or a registered runner pool) is missing. We refuse to
  // start with a half-configured implementer rather than quietly running the
  // repo-operating steps as useless one-shot LLM calls.
  const container = buildContainerExecutor(deps)
  if (!container) {
    throw configProblem({ key: 'CONTAINER_EXECUTOR', ...ENV_HELP.CONTAINER_EXECUTOR })
  }

  // Always the composite: non-sandbox kinds run inline; sandbox kinds run in the
  // container.
  return new CompositeAgentExecutor(inline, container, agentKindRegistry)
}

/** Truthy env flag (`true`/`1`/`yes`). */
function isTruthy(value: string | undefined): boolean {
  return value === 'true' || value === '1' || value === 'yes'
}

/**
 * Wrap the standard executor with the optional consensus mechanism when
 * `CONSENSUS_ENABLED` is set: register the consensus capability traits (so the builder
 * offers "Enable Consensus" on eligible steps) and route consensus-enabled steps through
 * a multi-model process, persisting + pushing the transcript. Off ⇒ returns `standard`
 * unchanged (no traits, no wrapping), so behaviour is identical to before.
 */
export function maybeWrapConsensus(
  standard: AgentExecutor,
  env: Env,
  config: AppConfig,
  db: D1Database,
  eventPublisher: ExecutionEventPublisher | undefined,
  agentKindRegistry: AgentKindRegistry,
): AgentExecutor {
  if (!isTruthy(env.CONSENSUS_ENABLED)) return standard
  registerConsensusTraits(agentKindRegistry)
  return new ConsensusAgentExecutor({
    standard,
    modelProviderResolver: buildModelProviderResolver(env, db),
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    sessionRepository: new D1ConsensusSessionRepository({ db }),
    ...(eventPublisher ? { eventPublisher } : {}),
    agentKindRegistry,
  })
}

/**
 * Build the factory that picks a job's runner backend: a workspace's own
 * self-hosted runner pool when one is registered (and runner pools are enabled),
 * otherwise the per-run Cloudflare Container. Returns null when neither backend is
 * available, so {@link buildContainerExecutor} falls back to inline work.
 */
export function buildResolveTransport(deps: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: Clock
  provisioningLog: ProvisioningLogRecorder | undefined
  // The app-owned runner-backend registry the service resolves a stored `kind` through.
  runnerBackendRegistry: RunnerBackendRegistry
  // The shared HTTP provider the built-in `manifest` backend reuses when supplied (its OAuth
  // cache reused). NOT the custom-kind seam — a bespoke runner backend is registered by
  // reference into `runnerBackendRegistry`. Absent → the generic manifest-driven HTTP provider.
  injectedPoolProvider?: RunnerPoolProvider
}): ResolveRunnerTransport | null {
  const { env, config, db, clock, provisioningLog, runnerBackendRegistry, injectedPoolProvider } =
    deps
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
        env.HARNESS_SHARED_SECRET?.trim() || undefined,
      )
    : null

  // The self-hosted backend path: a connection service that resolves each workspace's
  // runner-backend config (manifest pool OR native Kubernetes) to a live transport via
  // the runner-backend provider registry. The shared manifest HTTP provider (its OAuth
  // cache reused) is threaded in for the `manifest` kind.
  let runnerService: RunnerPoolConnectionService | undefined
  if (config.runners.enabled) {
    const urlPolicy = resolveUrlSafetyPolicy(config.runners)
    runnerService = new RunnerPoolConnectionService({
      runnerPoolConnectionRepository: new D1RunnerPoolConnectionRepository({ db }),
      workspaceRepository: new D1WorkspaceRepository({ db }),
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.runners.encryptionKey!,
        info: 'cat-factory:runners',
      }),
      clock,
      logger,
      runnerBackendRegistry,
      ...(urlPolicy ? { urlPolicy } : {}),
      runnerPoolProvider:
        injectedPoolProvider ?? new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
    })
  }

  if (!cloudflare && !runnerService) return null

  // Wrap a resolved transport so every dispatch/release/poll-failure appends a
  // provisioning-log event tagged with the right subsystem (a self-hosted pool vs a
  // per-run Cloudflare container). No-op when the separate log store isn't wired.
  // The dedup set is closure-owned so it outlives each (per-resolution) wrapper.
  const loggedPollFailures = new Set<string>()
  const log = (
    inner: RunnerTransport,
    subsystem: ProvisioningSubsystem,
    workspaceId: string | undefined,
    providerId?: string | null,
  ): RunnerTransport =>
    provisioningLog
      ? new LoggingRunnerTransport({
          inner,
          recorder: provisioningLog,
          workspaceId: workspaceId ?? '',
          subsystem,
          providerId,
          loggedPollFailures,
        })
      : inner

  return async (workspaceId) => {
    if (runnerService && workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) {
        return log(resolved.transport, 'runner-pool', workspaceId, resolved.providerId)
      }
    }
    if (cloudflare) return log(cloudflare, 'container', workspaceId)
    // The shared factory throws a ConflictError carrying the machine reason (see its doc): a clean
    // 409 synchronously, and classifyDispatchFailure lifts the reason onto the run's AgentFailure on
    // the async dispatch path (SPA shows "Agent backend not configured", not "container failed to
    // start"). The Cloudflare facade also offers "enable Cloudflare Containers" in the remedy.
    throw noRunnerBackendAvailableError(workspaceId, { cloudflareContainers: true })
  }
}

// The deployment-wide trusted web-search upstream for CONTAINER agents, built from this
// facade's own `WEB_SEARCH_*` env — the fallback the search proxy uses when a run's account
// configured none of its own (see `createDefaultWebSearchUpstream` in @cat-factory/server).
// Public endpoints only on workerd (no loopback-SearXNG story); kept symmetric with the Node
// facade so a stock Cloudflare deployment can also set a deployment-wide default.
export function buildDefaultWebSearchUpstream(env: Env): WebSearchUpstream | undefined {
  return createDefaultWebSearchUpstream({
    braveApiKey: env.WEB_SEARCH_BRAVE_API_KEY,
    searxngUrl: env.WEB_SEARCH_SEARXNG_URL,
    searxngApiKey: env.WEB_SEARCH_SEARXNG_API_KEY,
  })
}

/**
 * Build the container-based implementation executor, or return null when its
 * prerequisites are missing (a runner backend — Cloudflare Containers and/or a
 * self-hosted pool — plus a configured GitHub App, the proxy's public URL and the
 * signing secret) — the caller then falls back to inline work.
 */
function buildContainerExecutor(deps: WorkerExecutorDeps): AgentExecutor | null {
  const {
    env,
    config,
    db,
    clock,
    resolveTransport,
    agentKindRegistry,
    subscriptions,
    personalSubscriptions,
    agentContextObservability,
    resolvePackageRegistries,
    webSearchAccountSettings: webSearchSettings,
  } = deps
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
  // Record a subscription harness's (Claude Code / Codex) per-call telemetry into the
  // SAME `llm_call_metrics` store the LLM proxy writes for Pi — those harnesses bypass
  // the proxy, so the executor lifts the metrics off the CLI stream and feeds them here.
  // A standalone service over the required telemetry DB (the proxy path builds its own
  // from the same table; both are stateless writers). The settings repository is REQUIRED
  // here, not optional hygiene: a subscription harness's `stream-json` carries the FULL
  // prompt and response, and an absent repository makes `createStoreAgentContextGate` an
  // open gate — so without it an opted-out workspace's bodies are retained anyway, which is
  // exactly the privacy half of C2 (observability-logging-gaps.md) wearing a different hat.
  const recordHarnessCalls = makeHarnessCallRecorder(
    new LlmObservabilityService({
      llmCallMetricRepository: new D1LlmCallMetricRepository({ db: requireTelemetryDb(env) }),
      idGenerator: new CryptoIdGenerator(),
      clock,
      recordPrompts: config.observability.recordPrompts,
      workspaceSettingsRepository: new D1WorkspaceSettingsRepository({ db }),
      logger,
    }),
  )
  // Modeled subscription quota-cycle provider (usage-and-quota-tracking, Part B): folds a
  // finished subscription run's tokens into rolling windows (real vendor reads land in B2,
  // so its adapter registry is empty today — every vendor reports modeled).
  const subscriptionQuotaProvider = new RegistrySubscriptionQuotaProvider({
    subscriptionQuotaCycleRepository: new D1SubscriptionQuotaCycleRepository({ db }),
    idGenerator: new CryptoIdGenerator(),
    clock,
    registry: defaultSubscriptionQuotaRegistry,
  })
  // Prefer the run initiator's per-user PAT (when stored AND the workspace permits it) over
  // the App token, so the container's clone/push/PR is attributed to them. Falls back to the
  // App token; `resolveRunInitiatorToken` answers null for every "no" in that chain, and is
  // the SAME builder the engine's GitHub client uses, so the workspace's `allowInitiatorPat`
  // switch cannot bind one path and miss the other.
  const resolveRunInitiatorToken = buildResolveRunInitiatorToken(env, db, clock)
  const mintInstallationToken: MintInstallationToken = async (installationId, ctx) => {
    if (resolveRunInitiatorToken && ctx) {
      const pat = await resolveRunInitiatorToken(ctx)
      if (pat) return pat
    }
    return registry.installationToken(installationId)
  }

  // Decrypt the service frame's sensitive test credentials onto the tester job body (out of band).
  const testSecretsForDispatch = buildTestSecretsService(env, db, clock)
  const resolveTestSecrets = testSecretsForDispatch
    ? (workspaceId: string, blockId: string) =>
        testSecretsForDispatch.resolveValuesForBlock(workspaceId, blockId)
    : undefined
  // Advertise Pi's `web_search` tool to a run only when a usable upstream exists — either the
  // deployment-wide default (⇒ always on) or the run's account has its own keys (else the tool
  // would just fail / return nothing). The per-account check runs off `webSearchAccountSettings`.
  const defaultWebSearchUpstream = buildDefaultWebSearchUpstream(env)
  const resolveWebSearchAvailability =
    defaultWebSearchUpstream || webSearchSettings
      ? async (workspaceId: string): Promise<WebSearchAvailability> => {
          // Mirror the proxy's own resolution (`accountUpstream ?? defaultWebSearchUpstream`):
          // the run's account keys WIN and the deployment default is only the fallback, so the
          // surfaced provider matches the one that will actually serve the run's searches. Build
          // the account upstream the SAME way the proxy does before falling back to the default.
          if (webSearchSettings) {
            const accountId = await new D1WorkspaceRepository({ db }).accountOf(workspaceId)
            if (accountId) {
              const accountUpstream = createWebSearchUpstream(
                (await webSearchSettings.resolve(accountId)).webSearch ?? {},
              )
              if (accountUpstream) return { available: true, provider: accountUpstream.provider }
            }
          }
          if (defaultWebSearchUpstream)
            return { available: true, provider: defaultWebSearchUpstream.provider }
          return { available: false, provider: null }
        }
      : undefined

  return new ContainerAgentExecutor({
    resolveTransport,
    // Counts the seam's operational faults (dispatch failures, container evictions) beside the
    // per-job log lines. Wired on both facades — an absent collector would report zero of them.
    operationalMetrics,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    // The workspace's per-agent-kind default model, consulted when a block pins none
    // (block-pinned > workspace per-kind default > env routing > env default).
    resolveWorkspaceModelDefault: buildResolveWorkspaceModelDefault(db),
    resolveRepoTarget,
    // Multi-repo coding (service-connections phase 3): the implementer fans a cross-service
    // change out across the task's own repo + each connected involved-service repo.
    resolveRepoTargets: buildResolveRepoTargets(db),
    // Resolve the workspace's owning account so the proxy can lease account-scoped keys.
    resolveAccountId: (workspaceId) => new D1WorkspaceRepository({ db }).accountOf(workspaceId),
    mintInstallationToken,
    // Ensure the shared per-task work branch up front so every agent (including the
    // read-only architect) operates on the same branch — idempotent, best-effort. Writers
    // create it from base; read-only agents only probe (`options.create`).
    ensureWorkBranch: async (repo, branch, options) =>
      ensureWorkBranchViaRest({
        ...(config.github.apiBase ? { apiBase: config.github.apiBase } : {}),
        token: await registry.installationToken(repo.installationId),
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        branch,
        create: options.create,
      }),
    sessionService: new ContainerSessionService({ secret: env.AUTH_SESSION_SECRET }),
    // The subscription harnesses (Claude Code / Codex) lease a pooled token and
    // attribute usage back for usage-aware rotation; absent ⇒ those harnesses are
    // unavailable and a subscription-only model fails loudly at dispatch.
    ...(subscriptions
      ? {
          leaseSubscriptionToken: (workspaceId, vendor) =>
            subscriptions.leaseToken(workspaceId, vendor),
          recordSubscriptionUsage: (workspaceId, tokenId, usage) =>
            subscriptions.recordTokenUsage(workspaceId, tokenId, usage),
          hasSubscriptionToken: (workspaceId, vendor) =>
            subscriptions.hasToken(workspaceId, vendor),
        }
      : {}),
    // Per-call telemetry for the subscription harnesses (proxy-bypassing), recorded
    // into `llm_call_metrics` alongside the proxy-metered Pi rows.
    recordHarnessCalls,
    // Modeled subscription quota-cycle tracking (Part B): fold a finished subscription
    // run's tokens into the rolling windows, for BOTH pooled and personal runs.
    recordSubscriptionQuotaUsage: (target, usage) =>
      subscriptionQuotaProvider.recordUsage(target, usage),
    // Individual-usage harnesses (Claude) lease the run-initiator's OWN activated
    // personal credential; absent ⇒ such models fail loudly at dispatch.
    ...(personalSubscriptions
      ? {
          leasePersonalSubscriptionToken: (executionId, userId, vendor) =>
            personalSubscriptions.leaseForRun(executionId, userId, vendor),
          // Route a dual-mode individual model (GLM) to the initiator's own subscription
          // when they have one; otherwise dispatch keeps it on the Cloudflare base.
          hasPersonalSubscription: (userId, vendor) => personalSubscriptions.has(userId, vendor),
        }
      : {}),
    proxyBaseUrl: `${env.WORKER_PUBLIC_URL.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key in
    // the sandbox), but only for a run whose account has keys (see resolver above).
    ...(resolveWebSearchAvailability ? { resolveWebSearchAvailability } : {}),
    // Decrypt the workspace's private-registry entries onto the job body (rendered by
    // the harness into ~/.npmrc), so private dependencies resolve on install.
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
    // Decrypt the service frame's SENSITIVE test credentials onto the tester job body (out of
    // band — injected as container env vars by the harness, never in the prompt/telemetry).
    ...(resolveTestSecrets ? { resolveTestSecrets } : {}),
    // Resolve the credentials a registered capability (a TOOL SERVER, a generative binary
    // integration) declared. Defaults to reading them off the Worker's own configured vars; a
    // deployment needing per-workspace credentials passes its own `ToolSecretResolver` through
    // `createWorker`'s `createToolSecretResolver`, and the rest of the dispatch path is unchanged
    // either way.
    resolveToolSecrets:
      deps.resolveToolSecrets ??
      createEnvToolSecretResolver(env as unknown as Record<string, unknown>),
    logger,
    githubApiBase: config.github.apiBase,
    // Forward container tool spans to the external trace sink(s) (Langfuse and/or OTLP)
    // grouped under the run trace — the same sink the LLM proxy fans generations to.
    // (Langfuse nests them as children; the OTLP exporter groups them by shared trace id.)
    llmTraceSink: buildTraceSink(config),
    // Record the complete provided context per dispatch (best-effort, gated in the sink).
    ...(agentContextObservability ? { agentContextObservability } : {}),
    agentKindRegistry,
  })
}
