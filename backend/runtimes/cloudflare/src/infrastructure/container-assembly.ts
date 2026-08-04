import {
  type AppCaches,
  type Clock,
  DEFAULT_MODEL_PRESET_ID,
  type ExecutionEventPublisher,
  type IdGenerator,
  type ResolveBinaryArtifactStore,
} from '@cat-factory/kernel'
import {
  type CoreDependencies,
  AgentContextObservabilityService,
  SearchQueryObservabilityService,
  createCore,
} from '@cat-factory/orchestration'
import type {
  AccountSettingsService,
  ApiKeyService,
  LocalModelEndpointService,
  NotificationWebhookService,
  OpenRouterCatalogService,
  PersonalSubscriptionService,
  ProviderSubscriptionService,
  PublicApiKeyService,
  TestSecretsService,
  CapabilityCredentialsService,
  ValidationConfigService,
  UserSecretService,
} from '@cat-factory/integrations'
import {
  logger,
  operationalMetrics,
  runWithInitiator,
  resolveWorkspaceCapabilities,
  testEnvHasZeroConfigDefault,
  WebCryptoPasswordHasher,
  type PersistenceRegistry,
  type ServerContainer,
  type ToolSecretChain,
  type WebSearchUpstream,
} from '@cat-factory/server'
import {
  type GateProviderOverrides,
  applyGateProviders,
  warnUnwiredGates,
} from '@cat-factory/gates'
import type { NotificationChannel, RunLifecycleSink } from '@cat-factory/kernel'
import type { AppConfig } from './config'
import type { Env } from './env'
import type { WorkerRegistries } from './container-registries.js'
import { baseUrlFor } from './ai/providerEndpoints'
import { bedrockModelsCapability } from './ai/registries'
import type { ResolveRunnerTransport } from './ai/ContainerAgentExecutor'
import { DoRealtimeGateway } from './gateways/DoRealtimeGateway'
import {
  CfGitHubWebhookIngest,
  CfTrackerWebhookIngest,
  WorkflowsBackfillScheduler,
} from './gateways/GitHubGateways'
import { WorkersAiLlmUpstream } from './ai/WorkersAiLlmUpstream'
import { DurableObjectMachineEventRelay } from './events/DurableObjectMachineEventRelay'
import { WorkflowsBootstrapRunner } from './workflows/WorkflowsBootstrapRunner'
import { WorkflowsEnvConfigRepairRunner } from './workflows/WorkflowsEnvConfigRepairRunner'
import { WorkflowsEnvironmentTestRunner } from './workflows/WorkflowsEnvironmentTestRunner'
import { D1AccountRepository } from './repositories/D1AccountRepository'
import { D1AgentRunRepository } from './repositories/D1AgentRunRepository'
import { D1BinaryArtifactMetadataStore } from './repositories/D1BinaryArtifactMetadataStore'
import { D1BlockRepository } from './repositories/D1BlockRepository'
import { D1BootstrapJobRepository } from './repositories/D1BootstrapJobRepository'
import { CryptoIdGenerator } from './runtime'
import { D1AuthAttemptRepository } from './repositories/D1AuthAttemptRepository'
import { D1ConsensusSessionRepository } from './repositories/D1ConsensusSessionRepository'
import { D1MachineNodeRepository } from './repositories/D1MachineNodeRepository'
import { D1EnvConfigRepairJobRepository } from './repositories/D1EnvConfigRepairJobRepository'
import { D1EnvironmentTestRunRepository } from './repositories/D1EnvironmentTestRunRepository'
import { D1ExecutionRepository } from './repositories/D1ExecutionRepository'
import { D1GitHubInstallationRepository } from './repositories/D1GitHubInstallationRepository'
import { D1LlmCallMetricRepository } from './repositories/D1LlmCallMetricRepository'
import { D1AgentContextSnapshotRepository } from './repositories/D1AgentContextSnapshotRepository'
import { D1AgentSearchQueryRepository } from './repositories/D1AgentSearchQueryRepository'
import { D1MembershipRepository } from './repositories/D1MembershipRepository'
import { D1PipelineRepository } from './repositories/D1PipelineRepository'
import { D1PlatformMetricsRepository } from './repositories/D1PlatformMetricsRepository'
import { D1ProvisioningLogRepository } from './repositories/D1ProvisioningLogRepository'
import { D1ReferenceArchitectureRepository } from './repositories/D1ReferenceArchitectureRepository'
import { D1RepoProjectionRepository } from './repositories/D1RepoProjectionRepository'
import { D1SealedSecretInventory } from './repositories/D1SealedSecretInventory'
import { D1ServiceRepository } from './repositories/D1ServiceRepository'
import { D1SubscriptionActivationRepository } from './repositories/D1PersonalSubscriptionRepository'
import { D1TestSecretsRepository } from './repositories/D1TestSecretsRepository'
import { D1ValidationConfigRepository } from './repositories/D1ValidationConfigRepository'
import { D1ReportsRepository } from './repositories/D1ReportsRepository'
import { D1TokenUsageRepository } from './repositories/D1TokenUsageRepository'
import { D1UserRepoAccessRepository } from './repositories/D1UserRepoAccessRepository'
import { D1UserRepository } from './repositories/D1UserRepository'
import { D1WorkspaceMemberRepository } from './repositories/D1WorkspaceMemberRepository'
import { D1WorkspaceMountRepository } from './repositories/D1WorkspaceMountRepository'
import { D1WorkspaceRepository } from './repositories/D1WorkspaceRepository'
import {
  buildAppRegistry,
  buildExternalNotificationChannel,
  buildResolveRepoTarget,
  buildWorkerVcsIdentityRegistry,
  maybeWrapConsensus,
  selectAgentExecutor,
  type WorkerExecutorDeps,
  selectDeployDeps,
  selectDocumentsDeps,
  selectEmailInvitationDeps,
  selectEnvConfigRepairer,
  selectEnvironmentsDeps,
  selectFragmentLibraryDeps,
  selectIncidentEnrichmentDeps,
  selectMergeLifecycleDeps,
  selectPackageRegistryDeps,
  selectReleaseHealthDeps,
  selectRepoBootstrapper,
  selectRequirementsDeps,
  selectRunnersDeps,
  selectSandboxDeps,
  selectFoundationalServiceDeps,
  selectSkillLibraryDeps,
  selectSlackDeps,
  selectTasksDeps,
  selectTraceSink,
  selectWorkRunner,
} from './container.js'
import { selectRecurringDeps } from './container-tracker-deps.js'
import { selectGitHubDeps } from './github-deps.js'
import type { D1Database } from '@cloudflare/workers-types'

/**
 * The pre-built infrastructure handles + app-owned registries `buildContainer` computes
 * before assembly hands them to {@link assembleWorkerContainer}. Extracted from the
 * `buildContainer` god-function (lint-complexity-size-ratchet) so that composition root
 * stays under the per-function line budget — a behaviour-neutral move mirroring the Node
 * facade's `container-*-deps.ts` carve-outs. `buildContainer` still owns the ordering of
 * every side effect; this bundle just carries the handles across the call.
 */
export interface WorkerContainerAssemblyInput {
  env: Env
  config: AppConfig
  db: D1Database
  telemetryDb: D1Database
  clock: Clock
  idGenerator: IdGenerator
  caches: AppCaches
  overrides: Partial<CoreDependencies>
  gateProviders?: GateProviderOverrides
  cloudflareModelsEnabled: boolean
  registries: WorkerRegistries
  provisioningLogRepository: D1ProvisioningLogRepository | undefined
  resolveTransport: ResolveRunnerTransport | null
  subscriptions: ProviderSubscriptionService | undefined
  testSecretsService: TestSecretsService | undefined
  capabilityCredentialsService: CapabilityCredentialsService | undefined
  validationConfigService: ValidationConfigService
  personalSubscriptions: PersonalSubscriptionService | undefined
  apiKeys: ApiKeyService | undefined
  publicApiKeys: PublicApiKeyService | undefined
  /**
   * The outbound notification-webhook feature (management service + delivery channel), or null
   * when the deployment has no encryption key to seal the signing secret with. Both halves arrive
   * together from one builder so they can't drift apart.
   */
  notificationWebhookSupport: {
    service: NotificationWebhookService
    channel: NotificationChannel
    /** The run-lifecycle half — same endpoint, same secret, same guard. */
    runLifecycleSink: RunLifecycleSink
  } | null
  localModelEndpoints: LocalModelEndpointService | undefined
  userSecrets: UserSecretService | undefined
  openRouterCatalog: OpenRouterCatalogService | undefined
  eventPublisher: ExecutionEventPublisher | undefined
  agentContextObservability: AgentContextObservabilityService
  searchQueryObservability: SearchQueryObservabilityService
  accountSettings: AccountSettingsService | undefined
  /** The container executor's private-registry resolver — see {@link WorkerExecutorDeps}. */
  executorPackageRegistries: WorkerExecutorDeps['resolvePackageRegistries']
  /** The container executor's dedicated, uncached account-settings reader — see {@link WorkerExecutorDeps}. */
  webSearchAccountSettings: AccountSettingsService | undefined
  /**
   * The composed capability-credential chain: the resolver the container executor dispatches with,
   * and whether the deployment's own configured vars answer BEHIND the per-workspace store.
   *
   * Both halves come from one `buildToolSecretChain` call at the root, so the dispatch path and
   * the credential checklist cannot disagree about whether an unstored key still resolves. Its
   * `environmentFallback` is undefined when a deployment supplied its own resolver: it replaced
   * the chain, and nothing here knows what that consults.
   */
  toolSecretChain: ToolSecretChain
  defaultWebSearchUpstream: WebSearchUpstream | undefined
  resolveBinaryArtifactStore: ResolveBinaryArtifactStore
  githubWebhookIngest: CfGitHubWebhookIngest
}

/**
 * Assemble the Worker's {@link ServerContainer} from the infra handles + registries
 * `buildContainer` built: wire the domain `CoreDependencies` (spreading every `select*Deps`
 * module selector), wire the live env-config repair agent over the FINAL provider, apply any
 * test-injected gate providers, and surface the mothership/observability/credential handles on
 * the container. A behaviour-neutral extraction of the tail of `buildContainer` — the ordering
 * of the dependencies build, the `...overrides` spread, the post-override repairer wiring and
 * the gate-provider application is preserved exactly.
 */
/**
 * Build the engine {@link CoreDependencies} from the assembly input: every repository the Worker
 * serves off D1, the selected agent executor / work runner, and the `select*Deps` module
 * selectors, with the caller's `...overrides` applied LAST. Extracted verbatim from
 * {@link assembleWorkerContainer} so the runtime object is identical (later spreads still
 * override earlier ones in the same order) — purely the function-size ratchet split, not a
 * behaviour change.
 */
/**
 * The three secondary run kinds that each own a job store plus an optional Workflows-backed
 * durable driver: repo bootstrap, env-config repair and the ephemeral-environment self-test.
 * Grouped out of {@link buildWorkerCoreDependencies} so that assembler stays within the
 * per-function line budget; every entry is spread straight back into the same literal.
 */
function selectWorkerDurableJobDeps(args: {
  env: Env
  config: AppConfig
  db: D1Database
  clock: WorkerContainerAssemblyInput['clock']
  idGenerator: WorkerContainerAssemblyInput['idGenerator']
  resolveTransport: WorkerContainerAssemblyInput['resolveTransport']
}): Partial<CoreDependencies> {
  const { env, config, db, clock, idGenerator, resolveTransport } = args
  return {
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
    // Env-config-repair runs share the unified `agent_runs` table (kind-scoped). The
    // job repository is wired unconditionally; the repairer (the agent fallback) is wired
    // post-overrides over the FINAL provider, and the durable runner when its
    // Workflows binding is present (else the cron sweep re-drives a run left running).
    envConfigRepairJobRepository: new D1EnvConfigRepairJobRepository({ db }),
    envConfigRepairRunner: env.ENV_CONFIG_REPAIR_WORKFLOW
      ? new WorkflowsEnvConfigRepairRunner(env.ENV_CONFIG_REPAIR_WORKFLOW)
      : undefined,
    // The ephemeral-environment self-test: its own run store + the durable driver when the
    // Workflows binding is present. The Workflow self-finalizes on poll-budget exhaustion,
    // and the cron `sweepStuckEnvTests` (index.ts scheduled) is the backstop for a lost or
    // terminal instance — the run store is not agent_runs, so the unified run sweep never
    // covers it.
    environmentTestRunRepository: new D1EnvironmentTestRunRepository({ db }),
    environmentTestRunner: env.ENV_TEST_WORKFLOW
      ? new WorkflowsEnvironmentTestRunner(env.ENV_TEST_WORKFLOW)
      : undefined,
  }
}

/**
 * The pipeline-start capability probe: what a workspace + run initiator actually has
 * configured, which is what refuses a start with a clear cause instead of failing deep in a
 * provider SDK.
 *
 * Extracted from {@link buildWorkerCoreDependencies} to keep it inside its size budget. It is a
 * cohesive unit: every argument here exists only to answer that one question, and the closure is
 * built once per container rather than per call.
 */
function selectWorkerProviderCapabilities(
  deps: Pick<
    WorkerContainerAssemblyInput,
    | 'env'
    | 'config'
    | 'db'
    | 'caches'
    | 'apiKeys'
    | 'subscriptions'
    | 'personalSubscriptions'
    | 'cloudflareModelsEnabled'
    | 'localModelEndpoints'
    | 'openRouterCatalog'
    | 'accountSettings'
  > & { bedrockModels: Set<string> | undefined },
): NonNullable<CoreDependencies['resolveProviderCapabilities']> {
  const { env, config, db } = deps
  return (workspaceId, initiatedBy) =>
    resolveWorkspaceCapabilities(
      {
        apiKeys: deps.apiKeys,
        subscriptions: deps.subscriptions,
        personalSubscriptions: deps.personalSubscriptions,
        cloudflareModelsEnabled: deps.cloudflareModelsEnabled,
        ...(deps.bedrockModels ? { bedrockModels: deps.bedrockModels } : {}),
        baseUrlFor: (provider) => baseUrlFor(provider, env),
        localModelEndpoints: deps.localModelEndpoints,
        openRouterCatalog: deps.openRouterCatalog,
        accountSettings: deps.accountSettings,
        workspaceAccountOf: (id) => new D1WorkspaceRepository({ db }).accountOf(id),
        modelPolicySupported: config.infrastructure?.modelPolicy?.supported ?? false,
        caches: deps.caches,
      },
      workspaceId,
      initiatedBy,
    )
}

/**
 * The run-observability surface: the telemetry stores (TELEMETRY_DB), the deployment-level
 * rollup readers (MAIN db), the provisioning event log and the two capture sinks with their
 * prompt-recording switch. Grouped out of {@link buildWorkerCoreDependencies} for the
 * per-function line budget, like {@link selectWorkerDurableJobDeps}; every entry is spread
 * straight back into the same position in the same literal.
 */
function selectWorkerObservabilityDeps(args: {
  config: AppConfig
  db: D1Database
  telemetryDb: WorkerContainerAssemblyInput['telemetryDb']
  provisioningLogRepository: WorkerContainerAssemblyInput['provisioningLogRepository']
  agentContextObservability: AgentContextObservabilityService
  searchQueryObservability: SearchQueryObservabilityService
}): Partial<CoreDependencies> {
  const {
    config,
    db,
    telemetryDb,
    provisioningLogRepository,
    agentContextObservability,
    searchQueryObservability,
  } = args
  return {
    // Telemetry lives in the dedicated TELEMETRY_DB database.
    llmCallMetricRepository: new D1LlmCallMetricRepository({ db: telemetryDb }),
    // The stores behind the agent-context + search-query sinks re-exposed beside them, handed
    // in alongside for the remote debugging reader — a pure reader that wants neither capture
    // gate.
    agentContextSnapshotRepository: new D1AgentContextSnapshotRepository({ db: telemetryDb }),
    agentSearchQueryRepository: new D1AgentSearchQueryRepository({ db: telemetryDb }),
    // Deployment-level rollups over `agent_runs` (MAIN db, not telemetry) for the operator dashboard.
    platformMetricsRepository: new D1PlatformMetricsRepository({ db }),
    // Cross-cutting usage analytics over `token_usage` + `agent_runs` (both MAIN db) for
    // the Reports view.
    reportsRepository: new D1ReportsRepository({ db }),
    // Unified provisioning event log (separate D1 binding). Threads the recorder into
    // the env services and exposes the read service for the logs controller; undefined
    // when PROVISIONING_DB isn't bound.
    ...(provisioningLogRepository ? { provisioningLogRepository } : {}),
    recordLlmPrompts: config.observability.recordPrompts,
    // Re-exposed on the core for the agent-context read endpoint; the same instance is
    // injected into the container executor for the write path.
    agentContextObservability,
    // Re-exposed on the core for the search-query read endpoint AND the search proxy's
    // write path (it reads it off the request container).
    searchQueryObservability,
  }
}

function buildWorkerCoreDependencies(input: WorkerContainerAssemblyInput): CoreDependencies {
  const {
    env,
    config,
    db,
    telemetryDb,
    clock,
    idGenerator,
    caches,
    overrides,
    cloudflareModelsEnabled,
    registries,
    provisioningLogRepository,
    resolveTransport,
    subscriptions,
    testSecretsService,
    validationConfigService,
    personalSubscriptions,
    apiKeys,
    notificationWebhookSupport,
    localModelEndpoints,
    openRouterCatalog,
    eventPublisher,
    agentContextObservability,
    searchQueryObservability,
    accountSettings,
    executorPackageRegistries,
    webSearchAccountSettings,
    toolSecretChain,
    resolveBinaryArtifactStore,
    githubWebhookIngest,
  } = input
  const {
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    providerRegistry,
  } = registries
  // The Bedrock allow-list that gates `bedrock`-flavour selectability, derived from `env` here
  // (like `baseUrlFor` below) because it is one deployment-level read with nothing
  // per-workspace to resolve: Bedrock is reached with the deployment's own AWS credentials.
  // `bedrockModelsCapability` also requires a registered registry that can serve the route.
  const bedrockModels = bedrockModelsCapability(env)

  return {
    // The structured logger every domain service emits through. Must be wired on BOTH facades
    // or the Worker's engine silently falls back to `noopLogger` — which would put exactly the
    // best-effort paths this logger exists to surface back in the dark on the deployed runtime.
    logger,
    // The counter half of the same obligation, wired in the same position for the same reason:
    // an un-wired collector reads as "none of this ever happened". On this runtime it is
    // per-ISOLATE, which is why the entry points flush it rather than the cron alone.
    operationalMetrics,
    // App-owned backend registries (kind → provider) the connection services resolve through.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The code-defined custom provision-type catalog, merged with the workspace rows by
    // `listCustomTypes` so a programmatically-registered type surfaces in the infra editor + the
    // per-service provisioning picker.
    customManifestTypeRegistry,
    // Resolves the per-account binary-artifact store (screenshots) for the
    // visual-confirmation gate; resolving to null ⇒ the gate passes through.
    resolveBinaryArtifactStore,
    workspaceRepository: new D1WorkspaceRepository({ db }),
    workspaceMemberRepository: new D1WorkspaceMemberRepository({ db }),
    accountRepository: new D1AccountRepository({ db }),
    membershipRepository: new D1MembershipRepository({ db }),
    userRepository: new D1UserRepository({ db }),
    passwordHasher: new WebCryptoPasswordHasher(),
    blockRepository: new D1BlockRepository({ db }),
    pipelineRepository: new D1PipelineRepository({ db }),
    executionRepository: new D1ExecutionRepository({ db, clock }),
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    subscriptionActivationRepository: new D1SubscriptionActivationRepository({ db }),
    serviceRepository: new D1ServiceRepository({ db }),
    workspaceMountRepository: new D1WorkspaceMountRepository({ db }),
    tokenUsageRepository: new D1TokenUsageRepository({ db }),
    ...selectWorkerObservabilityDeps({
      config,
      db,
      telemetryDb,
      provisioningLogRepository,
      agentContextObservability,
      searchQueryObservability,
    }),
    idGenerator,
    clock,
    // When a caller injects its own agentExecutor (tests pass a FakeAgentExecutor)
    // skip selection entirely — selectAgentExecutor throws when a sandbox is opted
    // in but its prerequisites are missing, which is the desired loud failure in
    // production but must not fire for tests that never reach the real executor.
    agentExecutor:
      overrides.agentExecutor ??
      maybeWrapConsensus(
        selectAgentExecutor({
          env,
          config,
          db,
          clock,
          resolveTransport,
          agentKindRegistry,
          subscriptions,
          personalSubscriptions,
          agentContextObservability,
          resolvePackageRegistries: executorPackageRegistries,
          webSearchAccountSettings,
          resolveToolSecrets: toolSecretChain.resolver,
        }),
        env,
        config,
        db,
        eventPublisher,
        agentKindRegistry,
      ),
    agentKindRegistry,
    // The app-owned gate + step-resolver registries; the engine's gate machine + completion hub
    // read them, and the gate registry is re-exposed on Core for the boot-time validation.
    gateRegistry,
    // The app-owned JUDGE registry (the fourth step-taxonomy bucket); the engine's judge machine
    // reads it, and it is re-exposed on Core for the snapshot's palette projection.
    judgeRegistry,
    stepResolverRegistry,
    // The app-owned provider registry the gate providers were wired onto above; the engine's gate
    // machine reads the SAME instance through its GateContext.
    providerRegistry,
    initiativePresetRegistry,
    workRunner: selectWorkRunner(env),
    executionEventPublisher: eventPublisher,
    spendPricing: config.spend,
    // Price metered dynamic OpenRouter models at their real per-model rate (not the
    // bare-`openrouter` fallback) using this workspace's enabled catalog.
    dynamicModelPricesFor: openRouterCatalog
      ? (ws) => openRouterCatalog.capabilitiesFor(ws)
      : undefined,
    ...selectWorkerDurableJobDeps({ env, config, db, clock, idGenerator, resolveTransport }),
    ...selectGitHubDeps(env, config, db, clock, idGenerator, caches.repoFiles),
    ...selectMergeLifecycleDeps({
      env,
      config,
      db,
      clock,
      idGenerator,
      providerRegistry,
      webhookChannel: notificationWebhookSupport?.channel,
    }),
    // The run-lifecycle push: the terminal/started edges a headless integration would otherwise
    // have to poll for. Absent (no encryption key ⇒ no webhook feature) ⇒ nothing is pushed.
    ...(notificationWebhookSupport
      ? { runLifecycleSink: notificationWebhookSupport.runLifecycleSink }
      : {}),
    // A fresh workspace's model-preset library is seeded with Kimi K2.7 as the default
    // (Cloudflare-runnable on the bare AI binding). A deployment overrides the out-of-the-box
    // default by passing `defaultModelPresetId` through `createApp`'s / `buildContainer`'s
    // `overrides` (a `Partial<CoreDependencies>` field). Read explicitly here — rather than
    // relying on the trailing `...overrides` spread — so the seam stays legible and robust to a
    // future reorder. Applied only at first seed, so a user's later manual default choice wins.
    defaultModelPresetId: overrides.defaultModelPresetId ?? DEFAULT_MODEL_PRESET_ID,
    ...selectReleaseHealthDeps(env, config, db, providerRegistry),
    // Fold the service frame's SENSITIVE test-credential refs (key + description, never values)
    // into the tester prompt; present only when ENCRYPTION_KEY is set.
    ...(testSecretsService
      ? {
          resolveTestSecretRefs: (workspaceId: string, blockId: string) =>
            testSecretsService.resolveRefsForBlock(workspaceId, blockId),
        }
      : {}),
    // Fold the service frame's PRE-PR VALIDATION CHECKS onto the agent run context, so a
    // PR-opening coding dispatch carries them in its job body and the harness gates the PR on
    // them. Nothing sealed here (the commands run in the run's own container), so — unlike the
    // test secrets above — this needs no ENCRYPTION_KEY and is always wired. Resolves to `null`
    // for a service with no checks, which is the exact pre-feature behaviour.
    resolveValidationChecks: (workspaceId: string, frameId: string) =>
      validationConfigService.resolveForFrame(workspaceId, frameId),
    ...selectIncidentEnrichmentDeps(env, db, providerRegistry),
    ...selectPackageRegistryDeps(env, db),
    ...(accountSettings ? { accountSettings } : {}),
    ...selectSlackDeps(config, db),
    ...selectEmailInvitationDeps(config, db),
    ...selectTraceSink(config),
    ...selectRecurringDeps(env, config, db, clock, idGenerator),
    ...selectDocumentsDeps(env, config, db, clock, idGenerator),
    ...selectTasksDeps(env, config, db, clock, idGenerator),
    ...selectRequirementsDeps(env, config, db),
    ...selectSandboxDeps(env.SANDBOX_DB),
    ...selectEnvironmentsDeps(env, config, db),
    ...selectDeployDeps(env, config, db, clock),
    ...selectRunnersDeps(env, config, db),
    ...selectFragmentLibraryDeps(env, config, db),
    ...selectSkillLibraryDeps(env, config, db),
    // The foundational-services catalog: ungated (a service's contracts can be uploaded
    // directly, so it is useful without either repo-sourced library) — see the selector's note.
    ...selectFoundationalServiceDeps(db),
    // Push-webhook skill-source freshness fan-out (slice 4): resync affected sources via the
    // sync Queue. No queue bound (local/dev) ⇒ no proactive resync; the dispatch-time probe
    // is the freshness backstop.
    enqueueSkillResync: async ({ accountId, sourceId }) => {
      await githubWebhookIngest.queueSkillResync(accountId, sourceId)
    },
    // The same fan-out for repo-sourced foundational services.
    enqueueFoundationalResync: async ({ sourceId }) => {
      await githubWebhookIngest.queueFoundationalResync(sourceId)
    },
    // The app-owned cache bag (built above so the repo-files + account-policy resolvers share
    // it). Distributed invalidation is a genuine Node-only concern, not a facade-parity gap: the
    // Worker's cross-instance state already lives in globally-addressed DOs / D1.
    caches,
    // The pipeline-start guard resolves what's configured for a workspace + initiator.
    resolveProviderCapabilities: selectWorkerProviderCapabilities({
      env,
      config,
      db,
      caches,
      apiKeys,
      subscriptions,
      personalSubscriptions,
      cloudflareModelsEnabled,
      bedrockModels,
      localModelEndpoints,
      openRouterCatalog,
      accountSettings,
    }),
    // Run the engine's gate-probe / merge GitHub reads under the run initiator's ambient
    // context, so a per-user PAT (when set) is preferred over the App token.
    runInitiatorScope: runWithInitiator,
    ...overrides,
  }
}

/**
 * What the machine/auth boundary needs on this facade: the machine-node roster the shared gate
 * consults on every `/internal/*` call (SEC-5), the durable password-throttle ledger (SEC-4), and
 * the client address the throttle keys on.
 *
 * Grouped because the three are one concern and because `resolveClientAddress` is a per-FACADE
 * decision that must not drift from the store it feeds: `cf-connecting-ip` is authentic HERE and
 * only here, since the Cloudflare edge injects it and overwrites whatever the client sent, and a
 * Worker is unreachable except through that edge. The Node facade deliberately does NOT read that
 * header (a generic reverse proxy forwards it untouched), which is why the choice lives per facade
 * rather than behind a shared trust flag.
 */
function selectWorkerMachineAuthDeps(
  db: D1Database,
): Pick<
  ServerContainer,
  'machineNodeRepository' | 'authAttemptRepository' | 'resolveClientAddress'
> {
  return {
    machineNodeRepository: new D1MachineNodeRepository({ db }),
    authAttemptRepository: new D1AuthAttemptRepository({
      db,
      idGenerator: new CryptoIdGenerator(),
    }),
    resolveClientAddress: (c) => c.req.header('cf-connecting-ip') ?? undefined,
  }
}

export function assembleWorkerContainer(input: WorkerContainerAssemblyInput): ServerContainer {
  const { env, config, db, clock, registries, resolveTransport, gateProviders } = input
  const {
    subscriptions,
    testSecretsService,
    capabilityCredentialsService,
    toolSecretChain,
    validationConfigService,
    personalSubscriptions,
    apiKeys,
    publicApiKeys,
    notificationWebhookSupport,
    localModelEndpoints,
    userSecrets,
    openRouterCatalog,
    cloudflareModelsEnabled,
    defaultWebSearchUpstream,
    resolveBinaryArtifactStore,
    githubWebhookIngest,
  } = input
  const { environmentBackendRegistry, runnerBackendRegistry, providerRegistry, vcsRegistry } =
    registries
  const bedrockModels = bedrockModelsCapability(env)
  // The domain dependency object (built in its own function to stay within the size budget);
  // the post-override wiring below still reads + mutates THIS instance, exactly as before.
  const dependencies = buildWorkerCoreDependencies(input)

  // Wire the live env-config repair agent over the FINAL environment provider (after the
  // `...overrides` above), so a native adapter injected via overrides — not the default
  // manifest provider — is the one the repair dispatcher uses. Unwired on a stock deployment
  // (the generic provider has no `describeRepairAgent`), exactly like the service guard.
  const envConfigRepairer = selectEnvConfigRepairer({
    env,
    config,
    db,
    clock,
    resolveTransport,
    override: dependencies.environmentProvider,
    environmentBackendRegistry,
  })
  // Don't clobber an override-provided repairer (e.g. the conformance suite's fake): an
  // explicit `overrides.envConfigRepairer` wins, exactly like `repoBootstrapper`.
  if (envConfigRepairer && !dependencies.envConfigRepairer) {
    dependencies.envConfigRepairer = envConfigRepairer
  }

  // Apply any test-injected gate providers LAST, so they override the config wiring done by the
  // `select*Deps` spreads above (the conformance suite drives the externalized CI gate over a
  // faked verdict). Production leaves `gateProviders` undefined, so this is a no-op outside tests.
  applyGateProviders(providerRegistry, gateProviders)
  // Surface any gate left as a silent pass-through (no provider wired) so a misconfigured
  // deployment is visible in the logs instead of quietly auto-merging without checking CI.
  warnUnwiredGates(providerRegistry, logger)

  // The unified `agent_runs` reader (kind-spanning) — surfaced on the container for
  // `AgentRunController` AND folded into the mothership `repositories` registry below (it is the
  // one repo not carried by `CoreDependencies`). One instance shared by both.
  const agentRunRepository = new D1AgentRunRepository({ db })
  // The EXTERNAL (non-in-app) delivery channels, for the mothership delivery seam below. Built
  // from the same source of truth `selectMergeLifecycleDeps` composes into the engine's fan-out.
  const externalNotificationChannel = buildExternalNotificationChannel(
    config,
    db,
    notificationWebhookSupport?.channel,
  )

  return {
    ...createCore(dependencies),
    config,
    // The deployment-wide trusted web-search upstream (built from this facade's own `WEB_SEARCH_*`
    // env), read by `WebSearchProxyController` as the fallback when a run's account has no keys.
    // Surfaced on the ServerContainer here (not part of `CoreDependencies`, so `createCore` doesn't
    // carry it) — kept symmetric with the Node facade.
    ...(defaultWebSearchUpstream ? { defaultWebSearchUpstream } : {}),
    // Hosted source-control PAT login: a user signs in with their OWN GitHub/GitLab PAT (the
    // shared `/auth/pat` flow resolves it to an account, held to the login/org/domain allowlist).
    // GitHub always; GitLab when configured. Mirrors the Node facade so a GitLab-only Worker
    // deployment lets a GitLab user sign in (previously the Worker wired none, leaving it
    // OAuth-only / GitHub-only for sign-in even though the engine gated/merged on GitLab).
    vcsIdentity: buildWorkerVcsIdentityRegistry(config),
    // The app-owned VCS provider registry the neutral webhook route resolves a provider from.
    vcsRegistry,
    // The same checkout-free repo resolver the engine binds pre/post-ops with, surfaced so
    // the shared service-spec read controller can read the `spec/` artifact off main.
    resolveRunRepoContext: dependencies.resolveRunRepoContext,
    // The block→service→repo resolver, surfaced so the task-search controller can scope a
    // GitHub-issue search to the originating service's repo (and refuse it when unlinked).
    resolveRepoTarget: buildResolveRepoTarget(db),
    agentRunRepository,
    // Execution-scoped repo, surfaced for the conformance suite's compareAndSwap parity check.
    executionRepository: dependencies.executionRepository,
    // Mothership-side GitHub token delegation (`POST /internal/github/installation-token`):
    // when this deployment's GitHub App is configured, a machine-authed mothership-mode node
    // can mint the short-lived installation tokens its agent containers/gates need — the App
    // private key never leaves this Worker. The registry satisfies the seam structurally.
    // Wired symmetrically on the Node facade.
    ...(config.github.enabled
      ? { githubTokenDelegation: buildAppRegistry(env, config, db, clock) }
      : {}),
    // Mothership-side real-time UPSTREAM delivery (`POST /internal/events/publish`): when this
    // Worker is a mothership (its WORKSPACE_EVENTS hub is bound), a machine-authed mothership-mode
    // node's relayed engine events are injected into the per-workspace WorkspaceEventsHub Durable
    // Object, so hosted teammates on the shared board see the local node's activity live. Wired
    // symmetrically on the Node facade (the in-process hub / propagator). Absent binding ⇒ the
    // endpoint 503s.
    ...(env.WORKSPACE_EVENTS
      ? { machineEventRelay: new DurableObjectMachineEventRelay(env.WORKSPACE_EVENTS) }
      : {}),
    // Mothership-side notification DELIVERY (`POST /internal/notifications/deliver`): a
    // mothership-mode node persists its notification rows here but holds none of the org's
    // external delivery credentials (the Slack bot token is sealed with THIS Worker's key), so it
    // asks the mothership to deliver a row by id. Wired with the EXTERNAL channels only — the
    // in-app frame for a laptop-raised notification already arrives over the real-time upstream
    // relay, so delivering it here too would double-push it. Wired symmetrically on the Node
    // facade. Slack off ⇒ no external channel ⇒ the endpoint 503s.
    ...(externalNotificationChannel
      ? { machineNotificationDelivery: externalNotificationChannel }
      : {}),
    // The repository registry the mothership-mode machine API (`/internal/persistence`) reflects
    // over, so a Cloudflare deployment can act as a mothership for mothership-mode local nodes.
    // The controller gates which repo+method is callable (allow-list) and account-scopes each
    // call; exposing the whole `dependencies` (which carries every repo under its canonical name)
    // is safe. `agentRunRepository` is the one repo NOT part of `CoreDependencies` (the engine's
    // Core never reads it — it's surfaced separately above for `AgentRunController`), so fold it
    // in explicitly, else the board's retry/stop `getRef` call comes back `... is not wired`.
    // Sourced identically on both facades so they attach the same registry surface.
    repositories: {
      ...dependencies,
      agentRunRepository,
      // The binary-artifact METADATA store (visual-confirmation gate screenshots/references) is
      // not part of `CoreDependencies` (it's composed into `resolveBinaryArtifactStore`, not the
      // engine's Core), so fold it into the reflected registry explicitly — else a mothership-mode
      // node's artifact reads/writes come back `... is not wired`. The blob BYTES stay per-account
      // local; only the metadata is proxied.
      binaryArtifactMetadataStore: new D1BinaryArtifactMetadataStore({ db }),
      // The sensitive per-service test-credential store is org/durable state the engine reads via
      // the `resolveTestSecretRefs` FUNCTION (never the repo directly), so it isn't in
      // `CoreDependencies` either — fold it in explicitly, else a mothership-mode node's tester
      // run-path read + the inspector CRUD come back `... is not wired`. Only the SEALED blob is
      // proxied (decrypted service-side under the LOCAL key), like the observability/runner-pool
      // connections.
      testSecretsRepository: new D1TestSecretsRepository({ db }),
      // Same reasoning for the per-service PRE-PR VALIDATION CHECKS: the engine reads them via
      // the `resolveValidationChecks` FUNCTION, and the inspector CRUD goes through the service,
      // so the repo isn't in `CoreDependencies` — reflect it explicitly or a mothership-mode
      // node's dispatch resolution + inspector reads come back `... is not wired`.
      validationConfigRepository: new D1ValidationConfigRepository({ db }),
      // GitHub projection + installation reads the mothership serves over the persistence RPC even
      // when its OWN github service is off. A mothership-mode local node reaches GitHub by token
      // DELEGATION (no local App), which enables `container.github`, so its board snapshot
      // (`github.service.listRepos` → `repoProjectionRepository.list`) and run-path repo resolution
      // (`githubInstallationRepository.getByWorkspace` + `repoProjectionRepository.list`) read the
      // projection over RPC. Both are plain org tables the mothership owns (`selectGitHubDeps`
      // folds them into `dependencies` only when the App is configured), so reflect them regardless
      // of `config.github.enabled`, else a mothership without its own App 500s that board load with
      // `... is not wired`. Allow-listed in `REMOTE_PERSISTENCE_METHODS`; folded in explicitly like
      // the stores above. Sourced identically on both facades.
      repoProjectionRepository: new D1RepoProjectionRepository({ db }),
      githubInstallationRepository: new D1GitHubInstallationRepository({ db }),
    } as unknown as PersistenceRegistry,
    // The machine/auth boundary's own wiring (SEC-4 + SEC-5), mirrored on the Node facade.
    ...selectWorkerMachineAuthDeps(db),
    // App-owned backend registries, surfaced so the workspace snapshot's backend-kind
    // selectors (`environmentBackendKinds` / `runnerBackendKinds`) read the registered kinds.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The consensus transcript store, for the read endpoint (the SPA window's initial
    // load / reload). Always wired; live updates ride the `consensus` workspace event.
    consensusSessionRepository: new D1ConsensusSessionRepository({ db }),
    // Resolves the per-account binary-artifact store (screenshots) for the artifact
    // controllers + the visual-confirmation gate (configured per-account in the UI).
    resolveBinaryArtifactStore,
    // The Worker's only test-env backend is the `environment-provider` (its UI-test container is
    // torn down with the run — no long-lived in-container compose default), so a missing provider
    // IS a real gap the "test environment not configured" banner should surface. Derived from the
    // capability descriptor for symmetry with the Node facade (`testEnvHasZeroConfigDefault`).
    ephemeralEnvironmentsRequireProvider: !testEnvHasZeroConfigDefault(config.infrastructure),
    // The sensitive per-service test-credential store the shared test-secrets controller reads;
    // present when the shared ENCRYPTION_KEY is configured.
    ...(testSecretsService ? { testSecrets: testSecretsService } : {}),
    ...(capabilityCredentialsService
      ? { capabilityCredentials: capabilityCredentialsService }
      : {}),
    // What sits BEHIND that store in the chain this facade composed, so the credential checklist
    // describes the real chain instead of asserting the default beside it. Undefined when a
    // deployment supplied its own resolver: it replaced the chain, and nothing here can describe
    // what that consults.
    ...(toolSecretChain.environmentFallback === undefined
      ? {}
      : { toolSecretEnvironmentFallback: toolSecretChain.environmentFallback }),
    // The per-service pre-PR validation-check store the shared controller reads. Always present
    // (no secret material), unlike the sealed stores around it.
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
    notificationWebhooks: notificationWebhookSupport?.service,
    // Whether the opt-in Cloudflare Workers AI lib is enabled (the `AI` binding).
    cloudflareModelsEnabled,
    // The Bedrock allow-list gating `bedrock`-flavour selectability (see the sibling read in
    // `buildWorkerCoreDependencies`; both come from the one parser).
    ...(bedrockModels ? { bedrockModels } : {}),
    // The direct-provider base-URL resolver the catalog uses to gate selectability on a
    // resolvable endpoint (e.g. LiteLLM stays unselectable until LITELLM_BASE_URL is set).
    baseUrlFor: (provider) => baseUrlFor(provider, env),
    // The per-user locally-run model endpoints store; present when ENCRYPTION_KEY is set.
    localModelEndpoints,
    // The per-user generic secret store (GitHub PAT, …); present when ENCRYPTION_KEY is set.
    userSecrets,
    // The per-user "repos my PAT can reach" projection (board redaction + picker expansion).
    userRepoAccess: new D1UserRepoAccessRepository({ db }),
    // The sealed-secret inventory the key-drift sweep + drop remediation use (ADR 0026 D6.2/D6.3);
    // gated on ENCRYPTION_KEY (no key ⇒ nothing is sealed to scan).
    ...(env.ENCRYPTION_KEY?.trim()
      ? { sealedSecretInventory: new D1SealedSecretInventory({ db }) }
      : {}),
    // The per-workspace OpenRouter dynamic-catalog store; present when the API-key pool is.
    openRouterCatalog,
    gateways: {
      // Real-time event delivery via the per-workspace WorkspaceEventsHub DO (when
      // the WORKSPACE_EVENTS namespace is bound; absent → the events route 501s).
      realtime: new DoRealtimeGateway(env.WORKSPACE_EVENTS),
      // GitHub backfill via Workflows; webhook/resync ingest via the sync Queue. Both
      // fall back to inline handling when their binding is absent (local/dev/tests).
      githubBackfill: new WorkflowsBackfillScheduler(env.GITHUB_BACKFILL_WORKFLOW),
      githubWebhook: githubWebhookIngest,
      // Inbound TRACKER deliveries via the tracker sync Queue; absent binding ⇒ the receiver
      // applies each delivery inline, exactly like the GitHub seam above.
      trackerWebhook: new CfTrackerWebhookIngest(env.TRACKER_SYNC_QUEUE),
      // LLM proxy upstream: OpenAI-compatible providers from env keys + the in-process
      // Workers AI binding path (the `workers-ai` provider).
      llmUpstream: new WorkersAiLlmUpstream(env),
      // Container web-search upstream is resolved per-account by the proxy controller
      // (keys moved out of env into the per-account settings store), so no boot-time
      // gateway upstream is wired here.
    },
  }
}
