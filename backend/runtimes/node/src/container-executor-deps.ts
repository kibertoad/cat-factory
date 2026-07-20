// Container-agent-executor wiring for the Node facade, extracted out of `container.ts` so the
// composition root stays within the file-size budget. These are the seams `buildNodeContainer`
// (and the local facade / tests) compose: the runner-pool transport resolver, the
// provisioning-log wrapper, the container agent executor + repo bootstrapper + env-config
// repairer, the GitHub-issue filer, and the shared external trace-sink builder. Pure functions
// over explicit deps — no shared mutable state beyond the per-config trace-sink memo.
import { resolveAgentConfig, isProxyableProvider } from '@cat-factory/agents'
import type { AgentKindRegistry } from '@cat-factory/agents'
import {
  HttpRunnerPoolProvider,
  RunnerPoolConnectionService,
  LoggingRunnerTransport,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  createGitHubIssueViaToken,
} from '@cat-factory/integrations'
import type {
  EnvironmentBackendRegistry,
  ProvisioningLogRecorder,
  RunnerBackendRegistry,
} from '@cat-factory/integrations'
import { SUBSCRIPTION_VENDORS, composeTraceSinks, isAmbientNativeVendor } from '@cat-factory/kernel'
import type {
  AgentExecutor,
  Clock,
  GitHubClient,
  GitHubInstallationRepository,
  ProvisioningSubsystem,
  ResolveUserGitHubToken,
  RunnerPoolConnectionRepository,
  RunnerPoolProvider,
  SubscriptionQuotaTarget,
  TestSecretEntry,
  WebSearchAvailability,
} from '@cat-factory/kernel'
import {
  AgentContextObservabilityService,
  type CoreDependencies,
  type HarnessCallsRecordInput,
} from '@cat-factory/orchestration'
import { createLangfuseSink } from '@cat-factory/observability-langfuse'
import { createNodeOtelSink } from '@cat-factory/observability-otel/node'
import {
  type AppConfig,
  type JobPackageRegistrySpec,
  type MintInstallationToken,
  type ResolveRepoOrigin,
  type ResolveRepoTarget,
  type ResolveRepoTargets,
  type ResolveRunnerTransport,
  ContainerAgentExecutor,
  ContainerEnvConfigRepairer,
  ContainerRepoBootstrapper,
  ContainerSessionService,
  GitHubAppRegistry,
  WebCryptoSecretCipher,
  DOCS,
  ENV_VARS_ANCHORS,
  ensureWorkBranchViaRest,
  logger,
  noRunnerBackendAvailableError,
  resolveUrlSafetyPolicy,
} from '@cat-factory/server'

// HKDF domain tag separating runner-pool scheduler secrets from any other use of
// the same master key (mirrors the Worker's `cat-factory:runners`).
export const RUNNERS_CIPHER_INFO = 'cat-factory:runners'

// Memoised per config so both trace-sink wiring sites (the container executor here and the
// core/inline sinks in `buildNodeContainer`) share ONE instance — the OTel SDK sink owns
// batch processors/exporters, so it must be built once per config, not per wiring site.
const traceSinkCache = new WeakMap<AppConfig, CoreDependencies['llmTraceSink']>()

/**
 * Build the opt-in external trace sink(s) — Langfuse and/or OpenTelemetry — composed into
 * the single sink slot; the observability service then fans every recorded LLM call out to
 * whichever are wired. Memoised per config so both wiring sites share one instance.
 *
 * Langfuse uses the fetch-based sink (identical to the Worker). OpenTelemetry uses the
 * OFFICIAL `@opentelemetry/*` SDK exporter (`createNodeOtelSink`) — the Node counterpart of
 * the Worker's fetch OTLP exporter, kept conformant by the shared mapping layer + tests.
 */
export function buildTraceSink(config: AppConfig): CoreDependencies['llmTraceSink'] {
  if (traceSinkCache.has(config)) return traceSinkCache.get(config)
  const langfuse =
    !config.langfuse.enabled || !config.langfuse.publicKey || !config.langfuse.secretKey
      ? undefined
      : createLangfuseSink({
          publicKey: config.langfuse.publicKey,
          secretKey: config.langfuse.secretKey,
          baseUrl: config.langfuse.baseUrl,
          logger,
        })
  const otel =
    !config.otel.enabled || !config.otel.endpoint
      ? undefined
      : createNodeOtelSink({
          endpoint: config.otel.endpoint,
          headers: config.otel.headers,
          serviceName: config.otel.serviceName,
          logger,
        })
  const sink = composeTraceSinks([langfuse, otel])
  traceSinkCache.set(config, sink)
  return sink
}

export function buildNodeResolveTransport(
  config: AppConfig,
  // The port, not the Drizzle concrete: in mothership mode the local facade passes a remote
  // (RPC-backed) connection repo, and the service layer only ever uses the port methods.
  runnerPoolConnectionRepository: RunnerPoolConnectionRepository,
  workspaceRepository: CoreDependencies['workspaceRepository'],
  clock: Clock,
  // The app-owned runner-backend registry the service resolves a stored `kind` through.
  runnerBackendRegistry: RunnerBackendRegistry,
  // The shared HTTP provider the built-in `manifest` backend reuses when supplied (e.g.
  // tests). NOT the custom-kind seam — a bespoke runner backend is registered by reference
  // into `runnerBackendRegistry`. Absent → the generic manifest-driven HTTP provider.
  injectedPoolProvider?: RunnerPoolProvider,
): ResolveRunnerTransport | null {
  if (!config.runners.enabled || !config.runners.encryptionKey) return null
  const urlPolicy = resolveUrlSafetyPolicy(config.runners)
  const runnerService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository,
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.runners.encryptionKey,
      info: RUNNERS_CIPHER_INFO,
    }),
    clock,
    runnerBackendRegistry,
    ...(urlPolicy ? { urlPolicy } : {}),
    runnerPoolProvider:
      injectedPoolProvider ?? new HttpRunnerPoolProvider(urlPolicy ? { urlPolicy } : {}),
  })
  return async (workspaceId) => {
    if (workspaceId) {
      const resolved = await runnerService.resolve(workspaceId)
      if (resolved) return resolved.transport
    }
    // The shared factory throws a ConflictError carrying the machine reason (see its doc): a clean
    // 409 synchronously, and classifyDispatchFailure lifts the reason onto the run's AgentFailure on
    // the async dispatch path (SPA shows "Agent backend not configured", not "container failed to
    // start"). The Node facade has no per-run container backend, so the remedy points only at the
    // self-hosted runner pool / Kubernetes.
    throw noRunnerBackendAvailableError(workspaceId)
  }
}

/**
 * Wrap a transport resolver so every dispatch/release/poll-failure appends a
 * provisioning-log event. A no-op when there's no resolver. `subsystem` tags the
 * rows (a self-hosted pool vs a per-run container) so the logs drawer can filter.
 */
export function withProvisioningLog(
  resolve: ResolveRunnerTransport | null,
  recorder: ProvisioningLogRecorder,
  subsystem: ProvisioningSubsystem,
): ResolveRunnerTransport | null {
  if (!resolve) return null
  // Closure-owned so it survives each (per-resolution) wrapper: a terminal `failed`
  // job re-polled by a replay/re-drive logs its poll-failure only once.
  const loggedPollFailures = new Set<string>()
  return async (workspaceId) => {
    const inner = await resolve(workspaceId)
    return new LoggingRunnerTransport({
      inner,
      recorder,
      workspaceId: workspaceId ?? '',
      subsystem,
      loggedPollFailures,
    })
  }
}

/**
 * Which of the container-executor prerequisites are missing, as the human labels the boot
 * warning names. Empty ⇒ all three are present. `PUBLIC_URL` is this service's externally
 * reachable base backing the LLM proxy, `AUTH_SESSION_SECRET` signs the harness↔proxy tokens,
 * and a runner backend is what a dispatch is handed to. Pure so the "name exactly what's
 * missing" logic is unit-tested (error-message coverage A5).
 */
export function missingContainerExecutorPrereqs(input: {
  publicUrl: string | undefined
  sessionSecret: string | undefined
  hasRunnerBackend: boolean
}): string[] {
  const missing: string[] = []
  if (!input.publicUrl) missing.push('PUBLIC_URL')
  if (!input.sessionSecret) missing.push('AUTH_SESSION_SECRET (>= 32 chars)')
  if (!input.hasRunnerBackend) missing.push('a runner backend (self-hosted runner pool)')
  return missing
}

/**
 * Build the container agent executor (repo-operating steps: coder, mocker,
 * playwright, blueprints, ci-fixer, conflict-resolver, merger) when its
 * prerequisites are configured: a token source for the push/clone token, the public
 * URL backing the LLM proxy, the session secret to sign proxy tokens, and a runner
 * backend. Returns null when any is missing, so the composite fails those kinds
 * loudly rather than running them as useless one-shot LLM calls.
 *
 * The token source is pluggable: a sibling facade may pass `mintInstallationToken`
 * (e.g. a static PAT for local mode), otherwise it is minted via the GitHub App
 * registry (which additionally requires the App private key + `github.enabled`).
 */
export function buildNodeContainerExecutor(
  env: NodeJS.ProcessEnv,
  config: AppConfig,
  appRegistry: GitHubAppRegistry | undefined,
  resolveRepoTarget: ResolveRepoTarget,
  resolveRepoTargets: ResolveRepoTargets,
  resolveTransport: ResolveRunnerTransport | null,
  resolveWorkspaceModelDefault: (
    workspaceId: string,
    agentKind: string,
    modelPresetId?: string,
  ) => Promise<string | undefined>,
  agentKindRegistry: AgentKindRegistry,
  mintInstallationTokenOverride?: (installationId: number) => Promise<string>,
  subscriptions?: ProviderSubscriptionService,
  personalSubscriptions?: PersonalSubscriptionService,
  resolveAccountId?: (workspaceId: string) => Promise<string | null | undefined>,
  resolveUserGitHubToken?: ResolveUserGitHubToken,
  agentContextObservability?: AgentContextObservabilityService,
  resolveWebSearchAvailability?: (workspaceId: string) => Promise<WebSearchAvailability>,
  resolveRepoOrigin?: ResolveRepoOrigin,
  resolvePackageRegistries?: (workspaceId: string) => Promise<JobPackageRegistrySpec[]>,
  resolveTestSecrets?: (workspaceId: string, blockId: string) => Promise<TestSecretEntry[]>,
  recordHarnessCalls?: (input: HarnessCallsRecordInput) => Promise<void>,
  recordSubscriptionQuotaUsage?: (
    target: SubscriptionQuotaTarget,
    usage: { inputTokens: number; outputTokens: number },
  ) => Promise<void>,
): AgentExecutor | null {
  // The harness reaches models only through this service's LLM proxy; `PUBLIC_URL`
  // is this service's externally reachable base (the runner pool / local container
  // must be able to reach it). Pi posts to `${PUBLIC_URL}/v1/chat/completions`.
  const publicUrl = env.PUBLIC_URL?.trim()
  const sessionSecret = config.auth.sessionSecret

  if (!publicUrl || !sessionSecret || !resolveTransport) {
    // The executor is disabled but the service still boots "healthy" — repo-operating steps
    // (coder/mocker/tester/blueprints/ci-fixer/conflict-resolver/merger) then fail only at
    // dispatch, deep in a request, with no boot signal. Emit a greppable line naming exactly
    // which prerequisite is missing so the gap is visible up front (error-message coverage A5).
    const missing = missingContainerExecutorPrereqs({
      publicUrl,
      sessionSecret,
      hasRunnerBackend: !!resolveTransport,
    })
    logger.warn(
      { missing, docsUrl: DOCS.envVars(ENV_VARS_ANCHORS.coreServiceNetworking) },
      `container agent steps are DISABLED: missing ${missing.join(', ')}. Repo-operating steps ` +
        `(coder/mocker/tester/merger/…) will fail at dispatch until configured. See ` +
        `${DOCS.envVars(ENV_VARS_ANCHORS.coreServiceNetworking)}.`,
    )
    return null
  }

  // Token source: an explicit override (e.g. a static PAT in local mode) wins; else
  // the GitHub App registry mints a per-installation token (when the App is configured).
  const baseMint =
    mintInstallationTokenOverride ??
    (appRegistry ? (id: number) => appRegistry.installationToken(id) : undefined)
  if (!baseMint) {
    // Every other prerequisite is set but there is no GitHub token source, so the harness
    // could never clone/push. Name the fix (App creds) rather than disabling silently (A5).
    logger.warn(
      { missing: ['GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY'], docsUrl: DOCS.githubOperations() },
      `container agent steps are DISABLED: no GitHub token source — set GITHUB_APP_ID + ` +
        `GITHUB_APP_PRIVATE_KEY so the harness can mint a push/clone token. Repo-operating steps ` +
        `will fail at dispatch until configured. See ${DOCS.githubOperations()}.`,
    )
    return null
  }
  // Prefer the run initiator's per-user PAT (when stored) over the App/env token, so
  // pushes/PRs are attributed to them. Falls back to the base mint otherwise.
  const mintInstallationToken: MintInstallationToken = async (installationId, ctx) => {
    if (resolveUserGitHubToken && ctx?.initiatedBy) {
      const pat = await resolveUserGitHubToken(ctx.initiatedBy)
      if (pat) return pat
    }
    return baseMint(installationId)
  }

  return new ContainerAgentExecutor({
    resolveTransport,
    agentRouting: config.agents.routing,
    resolveBlockModel: config.agents.resolveBlockModel,
    resolveWorkspaceModelDefault,
    resolveRepoTarget,
    // Multi-repo coding (service-connections phase 3): the implementer fans a cross-service
    // change out across the task's own repo + each connected involved-service repo.
    resolveRepoTargets,
    ...(resolveAccountId ? { resolveAccountId } : {}),
    mintInstallationToken,
    // Ensure the shared per-task work branch up front so every agent (including the
    // read-only architect) operates on the same branch — idempotent, best-effort. Writers
    // create it from base; read-only agents only probe (`options.create`).
    ensureWorkBranch: async (repo, branch, options) =>
      ensureWorkBranchViaRest({
        ...(config.github.apiBase ? { apiBase: config.github.apiBase } : {}),
        token: await mintInstallationToken(repo.installationId),
        owner: repo.owner,
        name: repo.name,
        baseBranch: repo.baseBranch,
        branch,
        create: options.create,
      }),
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
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
    ...(recordHarnessCalls ? { recordHarnessCalls } : {}),
    // Modeled subscription quota-cycle tracking (Part B): fold a finished subscription
    // run's tokens into the rolling windows, for BOTH pooled and personal runs.
    ...(recordSubscriptionQuotaUsage ? { recordSubscriptionQuotaUsage } : {}),
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
    // Native local execution (local facade, opt-in): run subscription-harness agents with
    // the developer's OWN installed CLI + ambient login instead of leasing a credential.
    // Ambient auth applies ONLY when the resolved harness is in the allow-list AND the
    // vendor is that CLI's NATIVE vendor (no Anthropic-compatible base URL of its own:
    // `claude` / `codex`). A non-native vendor reusing the `claude-code` harness
    // (GLM/Kimi/DeepSeek carries its own `baseUrl`) is leased normally — otherwise ambient
    // auth would silently drop that base URL and run the step on the developer's own
    // Anthropic login instead of the pinned vendor.
    ...(config.nativeAmbientAuth && config.nativeAmbientAuth.length > 0
      ? {
          // The allow-list + no-`baseUrl` check is the shared `isAmbientNativeVendor`
          // predicate (so this can't drift from the personal-credential gate); the extra
          // `harness === h` guard ensures the RESOLVED harness matches the vendor's own.
          nativeAmbientAuth: (h, vendor) =>
            vendor !== undefined &&
            SUBSCRIPTION_VENDORS[vendor].harness === h &&
            isAmbientNativeVendor(config.nativeAmbientAuth, vendor),
        }
      : {}),
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    // Point container agents' web search at the backend search proxy (no provider key in
    // the sandbox), but only for a run whose account has keys (resolved per run — see the
    // call site), so the tool is never advertised to a run where it would just fail.
    ...(resolveWebSearchAvailability ? { resolveWebSearchAvailability } : {}),
    // Decrypt the workspace's private-registry entries onto the job body (rendered by
    // the harness into ~/.npmrc), so private dependencies resolve on install.
    ...(resolvePackageRegistries ? { resolvePackageRegistries } : {}),
    // Decrypt the service frame's SENSITIVE test credentials onto the tester job body (out of
    // band — injected as container env vars by the harness, never in the prompt/telemetry).
    ...(resolveTestSecrets ? { resolveTestSecrets } : {}),
    githubApiBase: config.github.apiBase,
    // Resolve the clone URL + provider per repo. The local GitLab facade injects a GitLab
    // origin so containers clone gitlab.com (or a self-managed host) and open MRs; absent ⇒
    // the default github.com origin.
    ...(resolveRepoOrigin ? { resolveRepoOrigin } : {}),
    // Forward container tool spans to the external trace sink(s) (Langfuse and/or OTLP)
    // grouped under the run trace — the same sink the LLM proxy fans generations to.
    // (Langfuse nests them as children; the OTLP exporter groups them by shared trace id.)
    llmTraceSink: buildTraceSink(config),
    // Record the complete provided context per dispatch (best-effort, gated in the sink).
    ...(agentContextObservability ? { agentContextObservability } : {}),
    agentKindRegistry,
  })
}

/**
 * Build the repo bootstrapper (the "bootstrap repo" container dispatch) when its
 * prerequisites are configured — mirroring the Worker's `selectRepoBootstrapper` and
 * the container-executor prerequisites: a resolvable runner transport, the public URL
 * + session secret backing the LLM proxy, a token source, and a GitHub client.
 * Returns undefined otherwise (the bootstrap module then has no runner and the service
 * reports a clean dispatch failure). Bootstrap is an `architect`-kind run, so it
 * follows that kind's routing. The promoted `ContainerRepoBootstrapper` dispatches
 * through the same shared runner seam the container executor uses, so on Node it runs
 * against the self-hosted pool and on local against the per-job Docker container.
 */
export function selectNodeRepoBootstrapper(deps: {
  env: NodeJS.ProcessEnv
  config: AppConfig
  resolveTransport: ResolveRunnerTransport | null
  installationRepository: GitHubInstallationRepository
  bootstrapJobRepository: ConstructorParameters<
    typeof ContainerRepoBootstrapper
  >[0]['bootstrapJobRepository']
  repoRepository: ConstructorParameters<typeof ContainerRepoBootstrapper>[0]['repoRepository']
  repoProjectionCache?: ConstructorParameters<
    typeof ContainerRepoBootstrapper
  >[0]['repoProjectionCache']
  githubClient: GitHubClient | undefined
  mintInstallationToken: ((installationId: number) => Promise<string>) | undefined
  resolvePackageRegistries?: (workspaceId: string) => Promise<JobPackageRegistrySpec[]>
}): ContainerRepoBootstrapper | undefined {
  const publicUrl = deps.env.PUBLIC_URL?.trim()
  const sessionSecret = deps.config.auth.sessionSecret
  if (
    !deps.resolveTransport ||
    !publicUrl ||
    !sessionSecret ||
    !deps.githubClient ||
    !deps.mintInstallationToken
  ) {
    return undefined
  }
  return new ContainerRepoBootstrapper({
    resolveTransport: deps.resolveTransport,
    installationRepository: deps.installationRepository,
    bootstrapJobRepository: deps.bootstrapJobRepository,
    repoRepository: deps.repoRepository,
    ...(deps.repoProjectionCache ? { repoProjectionCache: deps.repoProjectionCache } : {}),
    githubClient: deps.githubClient,
    mintInstallationToken: deps.mintInstallationToken,
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    model: resolveAgentConfig(deps.config.agents.routing, 'architect').ref,
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    githubApiBase: deps.config.github.apiBase,
    // The scaffolder installs dependencies too — forward the workspace's
    // private-registry entries exactly as the implementation executor does.
    ...(deps.resolvePackageRegistries
      ? { resolvePackageRegistries: deps.resolvePackageRegistries }
      : {}),
  })
}

/**
 * Build the live ENVIRONMENT-PROVIDER CONFIG REPAIR agent (PR #416 increment 2) when its
 * prerequisites are met — the same container prerequisites as the bootstrapper PLUS a
 * registered backend that supports agent repair (`describeRepairAgent`). The stock manifest
 * provider has no repair support, so this stays undefined there; it wires only when a custom
 * backend registered into the env-backend registry implements repair (so local inherits it
 * too). NOT the repo bootstrapper: an ordinary clone→edit→push coding job, no history reset.
 */
export function selectNodeEnvConfigRepairer(deps: {
  env: NodeJS.ProcessEnv
  config: AppConfig
  resolveTransport: ResolveRunnerTransport | null
  installationRepository: GitHubInstallationRepository
  mintInstallationToken: ((installationId: number) => Promise<string>) | undefined
  override: CoreDependencies['environmentProvider']
  environmentBackendRegistry: EnvironmentBackendRegistry
}): ContainerEnvConfigRepairer | undefined {
  const publicUrl = deps.env.PUBLIC_URL?.trim()
  const sessionSecret = deps.config.auth.sessionSecret
  // Prefer the internal override (the conformance suite's fake repair provider), else scan
  // the env-backend registry for the first repair-capable backend. Built-ins don't support
  // repair, so this is undefined on a stock deployment; a third-party backend wires it.
  const repairUrlPolicy = resolveUrlSafetyPolicy(deps.config.environments)
  const environmentProvider = !deps.resolveTransport
    ? undefined
    : (deps.override ??
      deps.environmentBackendRegistry.findRepairCapable(
        repairUrlPolicy ? { urlPolicy: repairUrlPolicy } : {},
      ))
  if (
    !deps.resolveTransport ||
    !publicUrl ||
    !sessionSecret ||
    !deps.mintInstallationToken ||
    !environmentProvider ||
    typeof environmentProvider.describeRepairAgent !== 'function'
  ) {
    return undefined
  }
  // A config fix is coding work, so it follows the `coder` kind's routing. The repair runs on
  // the Pi harness over the LLM proxy, so the routed model MUST be proxyable. Surface a
  // misconfiguration HERE (at wiring) rather than letting every repair dispatch throw deep in a
  // request: if `coder` is routed to a non-proxyable model (e.g. an individual subscription
  // vendor), leave the fallback unwired — bootstrap then returns the validation issues, exactly
  // as it does when no provider supports repair.
  const model = resolveAgentConfig(deps.config.agents.routing, 'coder').ref
  if (!isProxyableProvider(model.provider)) {
    logger.warn(
      { provider: model.provider },
      'env-config repair: the coder routing model is not proxyable by the LLM proxy; ' +
        'the agent config-repair fallback is disabled.',
    )
    return undefined
  }
  return new ContainerEnvConfigRepairer({
    resolveTransport: deps.resolveTransport,
    installationRepository: deps.installationRepository,
    mintInstallationToken: deps.mintInstallationToken,
    sessionService: new ContainerSessionService({ secret: sessionSecret }),
    environmentProvider,
    model,
    proxyBaseUrl: `${publicUrl.replace(/\/+$/, '')}/v1`,
    githubApiBase: deps.config.github.apiBase,
  })
}

/** Files a GitHub issue for a service frame, or null when none can be resolved. */
type GitHubIssueFiler = (request: {
  workspaceId: string
  frameId: string
  title: string
  body: string
}) => Promise<{ externalId: string; url: string } | null>

/**
 * Build the GitHub-issue tracker filer for the tech-debt pipeline when the GitHub
 * App is configured. It resolves the service's repo from the workspace's
 * `github_repos` projection and mints a short-lived token from that workspace's OWN
 * App installation (per-tenant) — the same infra the container executor uses — then
 * files the issue via the token. Returns undefined when the App isn't configured (the
 * GitHub tracker then passes through). A run whose service isn't linked to a repo
 * resolves to null (a clean pass-through, not a run failure).
 */
export function buildNodeGitHubIssueFiler(
  config: AppConfig,
  registry: GitHubAppRegistry | undefined,
  resolveRepoTarget: ResolveRepoTarget,
): GitHubIssueFiler | undefined {
  if (!registry) return undefined

  return async (request) => {
    let repo: Awaited<ReturnType<typeof resolveRepoTarget>>
    try {
      repo = await resolveRepoTarget(request.workspaceId, request.frameId)
    } catch {
      // The service isn't linked to a repo — nothing to file against; pass through.
      return null
    }
    if (!repo) return null
    const token = await registry.installationToken(repo.installationId)
    const issue = await createGitHubIssueViaToken({
      fetchImpl: fetch,
      token,
      owner: repo.owner,
      repo: repo.name,
      title: request.title,
      body: request.body,
      apiBase: config.github.apiBase,
    })
    return { externalId: `${repo.owner}/${repo.name}#${issue.number}`, url: issue.url }
  }
}
