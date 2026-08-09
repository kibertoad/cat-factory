// Opt-in AWS EKS backends (runner + environment), registered by reference below (the Worker
// facade registers the same pair, keeping the runtimes symmetric with the native `kubernetes`
// backend these extend). They are pass-throughs until a workspace actually connects an `eks`
// backend, and carry NO runtime AWS SDK dependency (the token is minted with WebCrypto), so this
// adds no cost to a deployment that never uses EKS.
import {
  ConfluenceProvider,
  resolveDeploymentDocumentResolver,
  FigmaProvider,
  ZeplinProvider,
  GitHubDocsProvider,
  LinearDocumentProvider,
  HttpRunnerPoolProvider,
  NotionProvider,
  EMAIL_CIPHER_INFO,
  createEmailSender,
  createDocumentConnectionStore,
  TicketTrackerService,
  AuditService,
} from '@cat-factory/integrations'
import {
  type DocumentSourceProvider,
  type EmailSender,
  type GitHubClient,
  type GitHubInstallationRepository,
  type RunLifecycleSink,
  type FoundationalSourceResyncRequest,
  type SkillSourceResyncRequest,
  DEFAULT_MODEL_PRESET_ID,
} from '@cat-factory/kernel'
import { type CoreDependencies } from '@cat-factory/orchestration'
import { promptFragmentRegistryWithBuiltins } from '@cat-factory/prompt-fragments'
import {
  type AppConfig,
  bedrockAllowListFromEnv,
  runWithInitiator,
  WebCryptoPasswordHasher,
  WebCryptoSecretCipher,
  logger,
  operationalMetrics,
  resolveUrlSafetyPolicy,
  resolveVcsWebUrls,
  resolveWorkspaceCapabilities,
} from '@cat-factory/server'
// The built-in polling-gate suite (ci / conflicts / post-release-health + on-call). The facade
// builds an app-owned `GateRegistry` pre-loaded with the suite via `gateRegistryWithBuiltins()`
// below, then wires each gate's provider.
import type { DrizzleDb } from './db/client.js'
import { executionRuntime } from './execution/config.js'
import { PgBossBootstrapRunner } from './execution/bootstrapRunner.js'
import { PgBossEnvConfigRepairRunner } from './execution/envConfigRepairRunner.js'
import { PgBossEnvironmentTestRunner } from './execution/envTestRunner.js'
import { PgBossWorkRunner } from './execution/pgBossRunner.js'
import { createNodeGateways } from './gateways.js'
import { baseUrlForNode } from './modelProvider.js'
import { DrizzleSubscriptionActivationRepository } from './repositories/personalSubscription.js'
import { createDrizzleRepositories, createDrizzleSandboxDeps } from './repositories/drizzle.js'
import { DrizzleReferenceArchitectureRepository } from './repositories/bootstrap.js'
import { DrizzleEnvConfigRepairJobRepository } from './repositories/envConfigRepair.js'
import { DrizzleEnvironmentTestRunRepository } from './repositories/environmentTest.js'
import {
  DrizzleDocumentConnectionRepository,
  DrizzleDocumentRepository,
} from './repositories/documents.js'
import {
  DrizzleEnvironmentConnectionRepository,
  DrizzleEnvironmentRegistryRepository,
} from './repositories/environments.js'
import { DrizzleCustomManifestTypeRepository } from './repositories/customManifestType.js'
import { DrizzleNotificationRepository } from './repositories/notifications.js'
import {
  selectNodeFragmentLibraryDeps,
  selectNodeFoundationalServiceDeps,
  selectNodeSkillLibraryDeps,
} from './container-content-library-deps.js'
// The container-agent-executor wiring (transport resolver, provisioning-log wrapper, container
// executor + bootstrapper + env-config repairer, GitHub-issue filer, trace-sink builder), lifted
// into a sibling module so this composition root stays within the file-size budget.
import { RUNNERS_CIPHER_INFO, buildTraceSink } from './container-executor-deps.js'

import type { NodeAppRegistriesResult, NodeContainerFoundation } from './container-foundation.js'
import type {
  NodeContainerOptions,
  NodeModelDepsResult,
  NodeTransportDeployResult,
  NodeRunServicesResult,
  NodeGitHubDepsResult,
  NodeBootstrapperResult,
  NodeRealtimeDepsResult,
  NodeAccountDepsResult,
} from './container.js'

/**
 * The engine {@link CoreDependencies} assembly for the Node facade, carved out of the
 * `container.ts` composition root so neither the bundle contract nor the (large) dependency
 * literal keeps that god-file — or its own function — over budget
 * (docs/initiatives/lint-complexity-size-ratchet.md). Behaviour-neutral: the literal is split
 * along a persistence/services seam into two builders whose spreads are concatenated in the
 * SAME order, so later keys still override earlier ones exactly as when it was one literal.
 */
/**
 * The intermediate values {@link buildNodeContainer} builds before it assembles the engine
 * {@link CoreDependencies}: the resolved config/options, the shared Drizzle repo set + the
 * mothership-aware `sourced` picker, and every build*Deps / select*Deps fragment.
 * Bundled so {@link assembleNodeCoreDependencies} can own the large `dependencies` object
 * literal (a size-only split — behaviour is identical), keeping the composition root within the
 * function-size budget.
 */
export interface NodeCoreDepsBundle {
  config: AppConfig
  options: NodeContainerOptions
  env: NodeJS.ProcessEnv
  db: DrizzleDb
  repos: ReturnType<typeof createDrizzleRepositories>
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T
  idGenerator: CoreDependencies['idGenerator']
  clock: CoreDependencies['clock']
  gateways: ReturnType<typeof createNodeGateways>
  runnerUrlPolicy: ReturnType<typeof resolveUrlSafetyPolicy>
  githubInstallationRepository: GitHubInstallationRepository
  environmentBackendRegistry: NodeAppRegistriesResult['environmentBackendRegistry']
  runnerBackendRegistry: NodeAppRegistriesResult['runnerBackendRegistry']
  customManifestTypeRegistry: NodeAppRegistriesResult['customManifestTypeRegistry']
  agentKindRegistry: NodeAppRegistriesResult['agentKindRegistry']
  gateRegistry: NodeAppRegistriesResult['gateRegistry']
  judgeRegistry: NodeAppRegistriesResult['judgeRegistry']
  stepResolverRegistry: NodeAppRegistriesResult['stepResolverRegistry']
  initiativePresetRegistry: NodeAppRegistriesResult['initiativePresetRegistry']
  providerRegistry: NodeAppRegistriesResult['providerRegistry']
  apiKeys: NodeModelDepsResult['apiKeys']
  subscriptions: NodeModelDepsResult['subscriptions']
  personalSubscriptions: NodeModelDepsResult['personalSubscriptions']
  localModelEndpoints: NodeModelDepsResult['localModelEndpoints']
  openRouterCatalog: NodeModelDepsResult['openRouterCatalog']
  modelProviderResolver: NodeModelDepsResult['modelProviderResolver']
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
  slackDeps: NodeRealtimeDepsResult['slackDeps']
  executionEventPublisher: NodeRealtimeDepsResult['executionEventPublisher']
  agentExecutor: NodeRealtimeDepsResult['agentExecutor']
  notificationChannel: NodeRealtimeDepsResult['notificationChannel']
  /** The notification manager's store, built beside the channels it routes. */
  notificationSettingsRepository: NodeRealtimeDepsResult['notificationSettingsRepository']
  /** The run-lifecycle half of the same registered endpoint (absent ⇒ no webhook configured). */
  runLifecycleSink: RunLifecycleSink | undefined
  releaseHealthDeps: NodeAccountDepsResult['releaseHealthDeps']
  packageRegistryDeps: NodeAccountDepsResult['packageRegistryDeps']
  incidentEnrichmentDeps: NodeAccountDepsResult['incidentEnrichmentDeps']
  accountSettings: NodeAccountDepsResult['accountSettings']
  resolveBinaryArtifactStore: NodeAccountDepsResult['resolveBinaryArtifactStore']
  /** The route order a model preset states, folded onto the resolved provider capabilities. */
  resolvePresetProviderPreference: NodeContainerFoundation['resolvePresetProviderPreference']
}

/**
 * Assemble the engine {@link CoreDependencies} from the {@link NodeCoreDepsBundle} the composition
 * root built. The object is split across two builders purely for the function-size ratchet — they
 * are spread in declaration order, so the resulting object is identical to the former single
 * literal (later spreads still override earlier ones).
 */
export function assembleNodeCoreDependencies(bundle: NodeCoreDepsBundle): CoreDependencies {
  // ONE service behind both audit seams. It is built here rather than inline below because the
  // write seam and the read seam are separate dependencies (a domain service may record but not
  // paginate; the viewer's controller may paginate but not record), and they must be the same
  // instance so a row appended through one is the row served by the other.
  const audit = new AuditService({
    auditEventRepository: bundle.repos.auditEventRepository,
    idGenerator: bundle.idGenerator,
    clock: bundle.clock,
    logger,
  })
  return {
    // The structured logger every domain service emits through. Wired at the TOP level (not
    // buried in one of the builders) because its Worker twin sits in the same position — the
    // pair is a facade-parity obligation, not an optional integration.
    logger,
    // The counter half of the same obligation, wired in the same position for the same reason:
    // an un-wired collector reads as "none of this ever happened".
    operationalMetrics,
    // The third member of that obligation: where privileged actions are RECORDED for an account
    // admin. Same position, same reason — an un-wired audit log reads as "nobody changed
    // anything", which is the assurance it exists to give.
    auditRecorder: audit,
    // The READ half, for the account-admin viewer. Same instance, different capability.
    auditLogReader: audit,
    ...buildNodeStoreDeps(bundle),
    ...buildNodeServiceDeps(bundle),
    // Mothership-mode SECRET DELEGATION, wired at the TOP level for the same reason the logger is:
    // it is not one integration's concern. Every service holding an ORG-owned sealed row composes
    // it with its own cipher, so a facade that forgot it would run each of them against a key the
    // org never sealed with, which fails at PROBE/PROVISION time, not at boot.
    ...(bundle.options.secretDelegate ? { secretDelegate: bundle.options.secretDelegate } : {}),
  }
}

/**
 * The run-observability surface: the telemetry sinks and their stores, the deployment-level
 * projections the operator dashboard aggregates, the provisioning event log and the
 * prompt-recording switch. The Node twin of the Worker's `selectWorkerObservabilityDeps`, in the
 * same shape and for the same two reasons: the per-function line budget (budgets are split
 * triggers, never numbers to raise), and keeping the facades legible side by side so a
 * projection wired on one is visibly missing from the other.
 *
 * `Partial` for the bulk, INTERSECTED with the one dependency `CoreDependencies` marks required:
 * without that intersection the spread erases the guarantee and the facade typechecks with the
 * engine's gate projection silently unwired, which is the failure this exists to prevent.
 */
function selectNodeObservabilityDeps(args: {
  config: NodeCoreDepsBundle['config']
  repos: NodeCoreDepsBundle['repos']
  agentContextObservability: NodeCoreDepsBundle['agentContextObservability']
  searchQueryObservability: NodeCoreDepsBundle['searchQueryObservability']
}): Partial<CoreDependencies> & Pick<CoreDependencies, 'gateOutcomeRepository'> {
  const { config, repos, agentContextObservability, searchQueryObservability } = args
  return {
    llmCallMetricRepository: repos.llmCallMetricRepository,
    // Deployment-level rollups over `agent_runs` for the operator dashboard.
    platformMetricsRepository: repos.platformMetricsRepository,
    // The settled-gate projection behind the dashboard's attempt statistics. This is the
    // dependency the ENGINE's gate machine records through, not only a read: wiring it on the
    // retention sweep alone leaves the table pruned and never written.
    gateOutcomeRepository: repos.gateOutcomeRepository,
    // Cross-cutting usage analytics over `token_usage` + `agent_runs` for the Reports view.
    reportsRepository: repos.reportsRepository,
    // The durable cost-attribution rollup the same view's long (TCO) windows read.
    spendRollupRepository: repos.spendRollupRepository,
    // The same ledger window the retention sweep prunes on, so a board delete's final fold into
    // the rollup above walks back exactly as far as a sweep pass would.
    tokenUsageRetentionMs: config.retention.tokenUsageMs,
    // Unified provisioning event log (its own Postgres schema). Threads the recorder
    // into the env services and exposes the read service for the logs controller.
    provisioningLogRepository: repos.provisioningLogRepository,
    recordLlmPrompts: config.observability.recordPrompts,
    // Re-exposed on the core for the agent-context read endpoint; the same instance
    // is injected into the container executor for the write path.
    agentContextObservability,
    // Re-exposed on the core for the search-query read endpoint AND the search proxy's
    // write path (it reads it off the request container).
    searchQueryObservability,
    // The stores behind the two sinks above, handed in alongside them for the remote
    // debugging reader: a pure reader that wants neither sink's capture gate.
    agentContextSnapshotRepository: repos.agentContextSnapshotRepository,
    agentSearchQueryRepository: repos.agentSearchQueryRepository,
    agentToolCallRepository: repos.agentToolCallRepository,
  }
}

/**
 * The app-owned REGISTRIES, as one mixin: the extension seams a deployment registers onto, plus
 * the mothership `*Source` reads that stand in for a registry when the node is one build behind
 * the deployment that registered the entry.
 *
 * Its own selector (the `selectNodeObservabilityDeps` shape) because "which seams this deployment
 * offers" is a different question from "which stores the engine reads", and keeping the two in one
 * literal is what pushed it over the function-size budget. A new registry joins THIS list.
 */
function selectNodeRegistryDeps(bundle: NodeCoreDepsBundle) {
  const {
    options,
    environmentBackendRegistry,
    runnerBackendRegistry,
    customManifestTypeRegistry,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    stepResolverRegistry,
    initiativePresetRegistry,
    providerRegistry,
  } = bundle
  return {
    // App-owned backend registries (kind → provider) the connection services resolve through.
    environmentBackendRegistry,
    runnerBackendRegistry,
    // The app-owned agent-kind registry (built-ins + any deployment-registered kinds); the
    // engine reads it (traits / inline-surface / pre-post-op hooks) and re-exposes it on Core.
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
    // The app-owned pipeline registry (deployment-registered extra pipelines); createCore threads
    // it into the workspace + pipeline services and re-exposes it on Core for boot-time validation.
    pipelineRegistry: options.pipelineRegistry,
    // The app-owned custom task-type registry (deployment-registered namespaced task types);
    // createCore threads it into the board service (default-pipeline resolution) and re-exposes it
    // on Core for the snapshot projection (`customTaskTypes`) + boot-time validation.
    taskTypeRegistry: options.taskTypeRegistry,
    // The app-owned foundational-service registry (the deployment's own shared-capability
    // catalog); createCore threads it into the catalog service as the `builtin` tier and
    // re-exposes it on Core for boot-time validation.
    foundationalServiceRegistry: options.foundationalServiceRegistry,
    // …and where that tier is READ from when it is not the registry above (mothership mode).
    foundationalBuiltinSource: options.foundationalBuiltinSource,
    // Two app-owned binary registries, siblings and not the same thing: the GENERATIVE
    // INTEGRATIONS a binary-generating step produces WITH (the catalog above is where that output
    // GOES), and the deployment's own artifact STORES, where a screenshot's bytes land. createCore
    // threads the first into the execution service; the second is read by the per-account store
    // resolver in `buildNodeAccountDeps`. Both are re-exposed on Core, for boot validation and to
    // make a boot's offered set readable.
    binaryGeneratorRegistry: options.binaryGeneratorRegistry,
    binaryStoreRegistry: options.binaryStoreRegistry,
    // …and where those integrations are READ from when it is not the registry above (mothership
    // mode), for the same reason its foundational sibling exists.
    binaryGeneratorSource: options.binaryGeneratorSource,
    // The app-owned prompt-fragment registry: the SHIPPED best-practice catalog plus whatever the
    // deployment registered onto the same instance. Defaulted here rather than in `createCore`,
    // because the engine's default is deliberately EMPTY: a facade must SAY it wants the platform's
    // standards, through the same public seam a consumer registers on.
    promptFragmentRegistry: options.promptFragmentRegistry ?? promptFragmentRegistryWithBuiltins(),
    // …and where that pool is READ from when it is not the registry above (mothership mode).
    promptFragmentSource: options.promptFragmentSource,
    // The app-owned initiative-preset registry; the initiative services read it and it is
    // re-exposed on Core for the snapshot descriptors + preset probe.
    initiativePresetRegistry,
    // The code-defined custom provision-type catalog, merged with the workspace rows by
    // `listCustomTypes` so a programmatically-registered type surfaces in the infra editor + the
    // per-service provisioning picker.
    customManifestTypeRegistry,
  }
}

/**
 * The first half of the dependency literal: every persisted repository the engine reads, the
 * app-owned registries ({@link selectNodeRegistryDeps}), and the module fragments that carry their
 * own stores (release-health / incident-enrichment / package-registry / tasks).
 */
function buildNodeStoreDeps(bundle: NodeCoreDepsBundle) {
  const {
    config,
    options,
    db,
    repos,
    sourced,
    modelProviderResolver,
    agentContextObservability,
    searchQueryObservability,
    resolveTestSecretRefs,
    resolveValidationChecks,
    tasks,
    releaseHealthDeps,
    packageRegistryDeps,
    incidentEnrichmentDeps,
    accountSettings,
    resolveBinaryArtifactStore,
    notificationSettingsRepository,
  } = bundle
  return {
    ...releaseHealthDeps,
    ...incidentEnrichmentDeps,
    ...packageRegistryDeps,
    // Fold the service frame's SENSITIVE test-credential refs (key + description, never values)
    // into the tester prompt. Present when ENCRYPTION_KEY is set; absent ⇒ no advertised secrets.
    ...(resolveTestSecretRefs ? { resolveTestSecretRefs } : {}),
    resolveValidationChecks,
    ...selectNodeRegistryDeps(bundle),
    ...(accountSettings ? { accountSettings } : {}),
    // Resolves the per-account binary-artifact store (screenshots) for the visual-confirmation
    // gate; resolving to null (no storage configured) ⇒ the gate passes through.
    resolveBinaryArtifactStore,
    workspaceRepository: repos.workspaceRepository,
    workspaceMemberRepository: repos.workspaceMemberRepository,
    accountRepository: repos.accountRepository,
    membershipRepository: repos.membershipRepository,
    userRepository: repos.userRepository,
    passwordHasher: new WebCryptoPasswordHasher(),
    blockRepository: repos.blockRepository,
    pipelineRepository: repos.pipelineRepository,
    executionRepository: repos.executionRepository,
    // Clear a finished run's personal-credential activation promptly (TTL sweep is the backstop).
    // In mothership mode its home is the LOCAL `node:sqlite` credential bucket (the activation
    // re-seals the token for the run, and the LOCAL container executor decrypts it), injected via
    // `options.subscriptionActivationRepository` — the SAME instance the personal-subscription
    // service above mints into, so mint + clear agree. Absent (plain Node / siloed-Postgres local)
    // → the Drizzle repo over `db`. This is NEVER routed through `sourced` (the remote registry):
    // every no-db (mothership) caller injects the override — `buildLocalContainer` in production
    // and `makeMothershipConformanceApp` in tests — so `db` here is always a real Postgres handle,
    // and routing an activation clear to the mothership (where `deleteByExecution` isn't
    // allow-listed) is a path no caller takes.
    subscriptionActivationRepository:
      options.subscriptionActivationRepository ?? new DrizzleSubscriptionActivationRepository(db),
    // In-org shared services. When a realtime hub is wired (start()), the engine's
    // event publisher (composed above) is a `FanOutEventPublisher` over these two repos,
    // so a shared service's live events reach every board that mounts it — parity with
    // the Cloudflare facade. Without a hub (createServer/tests) the engine uses its
    // NoopEventPublisher and nothing is pushed.
    serviceRepository: repos.serviceRepository,
    workspaceMountRepository: repos.workspaceMountRepository,
    tokenUsageRepository: repos.tokenUsageRepository,
    ...selectNodeObservabilityDeps({
      config,
      repos,
      agentContextObservability,
      searchQueryObservability,
    }),
    // Opt-in external trace sink(s) — Langfuse and/or OpenTelemetry — fanning every
    // recorded LLM call out as a generation. Built only when configured; otherwise
    // undefined and there is no external emission.
    llmTraceSink: buildTraceSink(config),
    modelPresetRepository: repos.modelPresetRepository,
    // The consensus-GROUP library: the estimate-gated panels a pipeline step escalates to. Read
    // by the settings controller AND on the run path (per-dispatch tier resolution).
    consensusGroupRepository: repos.consensusGroupRepository,
    agentPromptRepository: repos.agentPromptRepository,
    // Per-agent-kind generation settings (the output-token ceiling). Read by the settings
    // controller AND on the run path (per-dispatch ceiling resolution).
    workspaceAgentSettingsRepository: repos.workspaceAgentSettingsRepository,
    // Which registered reusable operations this board HIDES. Read by the settings controller, by
    // the board snapshot's catalog projection, and on the CREATION path (the refusal that keeps
    // every non-picker door in step with the picker).
    taskTypeSuppressionRepository: repos.taskTypeSuppressionRepository,
    // A fresh workspace's model-preset library is seeded with this built-in as the default
    // (Node deploy → Kimi K2.7, the Cloudflare-runnable baseline; the local facade injects
    // Claude). Applied only at first seed, so a user's later manual default choice wins.
    defaultModelPresetId: options.defaultModelPresetId ?? DEFAULT_MODEL_PRESET_ID,
    // A deployment's pre-declared environment-handler seeds. `createCore` builds the seeder over
    // them (when the environments module is wired) and exposes it for the boot backfill + the
    // WorkspaceService on-create hook. Undefined ⇒ no seeding. The local facade rides this via `o`.
    seedEnvironmentHandlers: options.seedEnvironmentHandlers,
    // …and the pre-declared shared stacks, under the same rules. `createCore` builds the seeder
    // over them (when the shared-stacks module is wired) and exposes it for the same two sites.
    seedSharedStacks: options.seedSharedStacks,
    serviceFragmentDefaultsRepository: repos.serviceFragmentDefaultsRepository,
    // Requirements-review feature (stateless reviewer + the requirements-rework
    // step). Wired identically to the Cloudflare facade's `selectRequirementsDeps`
    // so both runtimes serve the review/rework API AND substitute a block's reworked
    // requirements into the agent context (the cross-runtime conformance suite asserts
    // the substitution against both stores). The reviewer's model resolves exactly
    // like a pipeline step: block-pin > workspace per-kind default > routing default
    // (which falls back to Cloudflare Workers AI unless a direct key is set).
    requirementReviewRepository: repos.requirementReviewRepository,
    // Interactive document-interview sessions (WS5). Wired unconditionally; the interviewer
    // reuses the requirements reviewer's model config resolved just below.
    docInterviewRepository: repos.docInterviewRepository,
    // Kaizen agent (post-run grading). Wired unconditionally, mirroring the Cloudflare
    // facade, so the engine schedules gradings at run completion and the background sweep
    // runs them. The grader resolves its model for the `kaizen` kind exactly like a step.
    kaizenGradingRepository: repos.kaizenGradingRepository,
    kaizenVerifiedComboRepository: repos.kaizenVerifiedComboRepository,
    clarityReviewRepository: repos.clarityReviewRepository,
    brainstormSessionRepository: repos.brainstormSessionRepository,
    // Initiatives (the long-running multi-task work container). Wired unconditionally,
    // mirroring the Worker's `selectMergeLifecycleDeps`, so the create/read API + the
    // planning pipeline's ingest/committer steps work identically on both runtimes.
    initiativeRepository: repos.initiativeRepository,
    // Merge threshold presets: the per-workspace auto-merge ceiling library a task's
    // merge gate resolves (block-pinned preset > workspace default). Wired
    // unconditionally, exactly like the Worker's `selectMergeLifecycleDeps`, so the
    // preset CRUD API + the merger step's threshold resolution work identically.
    riskPolicyRepository: repos.riskPolicyRepository,
    mergeTrackRecordRepository: repos.mergeTrackRecordRepository,
    // Shared stacks (long-lived compose infra a consumer environment attaches to). Wired
    // unconditionally like the merge presets so the CRUD API works identically on both
    // runtimes; the bring-up (`ensureUp`) needs a host daemon, so plain Node has no
    // `composeRuntime` — the local facade injects one via `overrides.composeRuntime`.
    sharedStackRepository: repos.sharedStackRepository,
    // Sandbox (parallel prompt/model testing) — contributed as one sandbox-owned mixin,
    // symmetric with the Worker's `...selectSandboxDeps(db)`; the run-driver reuses the
    // reviewer model config below. The container body never enumerates the five repos.
    ...createDrizzleSandboxDeps(db),
    // Per-workspace runtime settings (human-wait escalation threshold + per-service task
    // limit). Wired unconditionally so the settings API + the limit enforcement + the
    // escalation sweep work identically to the Worker.
    workspaceSettingsRepository: repos.workspaceSettingsRepository,
    userSettingsRepository: repos.userSettingsRepository,
    tutorialProgressRepository: repos.tutorialProgressRepository,
    modelProviderResolver,
    requirementReviewModel: config.agents.routing.default.ref,
    requirementReviewResolveModel: config.agents.resolveBlockModel,
    // Local mode runs the inline reviewers/brainstorm/estimator on the ambient Claude Code /
    // Codex CLI when the pinned model is a subscription harness (undefined on stock Node, so
    // such refs degrade to the routing default). Also drives the preset satisfiability guard.
    ...(config.agents.inlineHarnessRef ? { inlineHarnessRef: config.agents.inlineHarnessRef } : {}),
    // Notifications subsystem (parity with the Worker, which wires it unconditionally):
    // the inbox + the human-action surfaces. Node has no real-time push, so the rows
    // persist (inbox + snapshot) and any channel composed below — e.g. Slack — delivers.
    notificationRepository: sourced(
      'notificationRepository',
      (d) => new DrizzleNotificationRepository(d),
    ),
    // The manager's store — the SAME instance the routed channels were built over.
    notificationSettingsRepository,
    ...tasks.deps,
    // Recurring pipelines + the workspace tracker selection. The tracker provider
    // files the tech-debt pipeline's issue by resolving the *workspace's* connected
    // integration: GitHub issues through the workspace's GitHub App installation,
    // Jira tickets from the per-workspace encrypted connection store — both per-tenant.
    pipelineScheduleRepository: repos.pipelineScheduleRepository,
    trackerSettingsRepository: repos.trackerSettingsRepository,
    ticketTrackerProvider: buildTicketTrackerProvider(bundle),
  }
}

/**
 * The workspace's ticket tracker: GitHub issues through the workspace's App installation, Jira and
 * Linear from the per-workspace encrypted connection store, all per-tenant.
 *
 * Its own function because the two credential resolvers are the bulk of it and neither belongs to
 * the dependency literal's shape: pulling them out keeps that literal readable as the list of
 * bindings it is.
 */
function buildTicketTrackerProvider(bundle: NodeCoreDepsBundle): TicketTrackerService {
  const { repos, tasks, fileGitHubIssue } = bundle
  const store = tasks.taskConnectionStore
  return new TicketTrackerService({
    trackerSettingsRepository: repos.trackerSettingsRepository,
    fetchImpl: fetch,
    ...(fileGitHubIssue ? { fileGitHubIssue } : {}),
    ...(store
      ? {
          resolveJiraConnection: async (workspaceId) => {
            const connection = await store.getByWorkspace(workspaceId, 'jira')
            const { baseUrl, accountEmail, apiToken } = connection?.credentials ?? {}
            if (!baseUrl || !accountEmail || !apiToken) return null
            return { baseUrl, accountEmail, apiToken }
          },
          resolveLinearConnection: async (workspaceId) => {
            const connection = await store.getByWorkspace(workspaceId, 'linear')
            const { apiKey, token } = connection?.credentials ?? {}
            return apiKey || token ? { apiKey, token } : null
          },
        }
      : {}),
  })
}

/**
 * The second half of the dependency literal: the runtime collaborators (executor, gateways,
 * bootstrapper, deploy/runner transports, GitHub + Slack module wiring, the capability resolver)
 * and — LAST, exactly as before — the caller's `overrides`.
 */
function buildNodeServiceDeps(bundle: NodeCoreDepsBundle) {
  const {
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
    apiKeys,
    subscriptions,
    personalSubscriptions,
    localModelEndpoints,
    openRouterCatalog,
    modelProviderResolver,
    cloudflareModelsEnabled,
    deployDeps,
    runnerPoolConnectionRepository,
    githubClient,
    issueWritebackProvider,
    githubGateDeps,
    githubModuleDeps,
    bootstrapJobRepository,
    repoBootstrapper,
    slackDeps,
    executionEventPublisher,
    agentExecutor,
    notificationChannel,
    runLifecycleSink,
    accountSettings,
    resolvePresetProviderPreference,
  } = bundle
  // The Bedrock allow-list gating `bedrock`-flavour selectability: one deployment-level env
  // read (Bedrock uses the deployment's own AWS credentials, so nothing resolves per
  // workspace), from the same parser that constrains the resolver itself.
  const bedrockModels = bedrockAllowListFromEnv(env)
  return {
    issueWritebackProvider,
    idGenerator,
    clock,
    agentExecutor,
    // This service's own externally-reachable URL — the same value the container harness reaches
    // the LLM proxy on. The verification report builds direct links to captured artifacts' bytes
    // from it; unset ⇒ the report lists artifact ids with no link, never a link to nowhere.
    apiBaseUrl: env.PUBLIC_URL?.trim() || undefined,
    // The browser-facing host of each provider's configured instance, stamped onto every VCS
    // connection + connect option so the SPA links to the instance a workspace is bound to.
    // Derived by the shared resolver both facades call, so they cannot name different hosts.
    vcsWebUrls: resolveVcsWebUrls(config),
    spendPricing: config.spend,
    // Price metered dynamic OpenRouter models at their real per-model rate (not the
    // bare-`openrouter` fallback) using this workspace's enabled catalog.
    dynamicModelPricesFor: openRouterCatalog
      ? (ws: string) => openRouterCatalog.capabilitiesFor(ws)
      : undefined,
    // The runner-pool integration assembles when enabled, so a workspace can
    // register the self-hosted pool its container agents dispatch to.
    ...(config.runners.enabled && config.runners.encryptionKey
      ? {
          runnerPoolConnectionRepository,
          runnerSecretCipher: new WebCryptoSecretCipher({
            masterKeyBase64: config.runners.encryptionKey,
            info: RUNNERS_CIPHER_INFO,
          }),
          // The pool provider instance backs the connection service's describeProvider +
          // testConnection (the manifest editor's secret-key form + a pre-save probe). An
          // injected native adapter wins here too (same instance that drives dispatch), so
          // its describeConfig/testConnection render — else the generic manifest provider
          // (same SSRF policy as the dispatch transport).
          runnerPoolProvider:
            options.runnerPoolProvider ??
            new HttpRunnerPoolProvider(runnerUrlPolicy ? { urlPolicy: runnerUrlPolicy } : {}),
          // Node (and local) has undici, so it can verify a private CA / skip TLS for a
          // Kubernetes apiserver — accept such a config at registration.
          runnerCustomTlsSupported: true,
          ...(runnerUrlPolicy ? { runnerUrlSafetyPolicy: runnerUrlPolicy } : {}),
        }
      : {}),
    ...(options.boss
      ? {
          workRunner: new PgBossWorkRunner(options.boss, executionRuntime(config, env).queue),
          // The durable bootstrap driver (analogue of the Worker's BootstrapWorkflow):
          // BootstrapService.startRun enqueues a drive job that polls the run to terminal.
          bootstrapRunner: new PgBossBootstrapRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
          // The durable env-config-repair driver (analogue of the Worker's
          // EnvConfigRepairWorkflow): start enqueues a drive job that polls the run to terminal.
          envConfigRepairRunner: new PgBossEnvConfigRepairRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
          // The durable ephemeral-environment self-test driver (analogue of the Worker's
          // EnvironmentTestWorkflow): startRun enqueues a drive job that advances the run.
          environmentTestRunner: new PgBossEnvironmentTestRunner(
            options.boss,
            executionRuntime(config, env).queue,
          ),
        }
      : {}),
    ...githubGateDeps,
    // GitHub installation + repo/branch/PR/issue/commit/check-run projections + the
    // sync/webhook module (inline ingest persists to these repos on Node).
    ...githubModuleDeps,
    // Repo-bootstrap: the reference-architecture library + bootstrap-run store make the
    // module + API available; `repoBootstrapper` (when wired) dispatches the bootstrap
    // container through the shared runner seam, and `bootstrapRunner` (pg-boss, below)
    // durably drives its poll loop — parity with the Worker's BootstrapWorkflow.
    referenceArchitectureRepository: sourced(
      'referenceArchitectureRepository',
      (d) => new DrizzleReferenceArchitectureRepository(d),
    ),
    bootstrapJobRepository,
    ...(repoBootstrapper ? { repoBootstrapper } : {}),
    // Env-config-repair runs share the unified agent_runs table (kind-scoped). The job
    // repository is wired unconditionally; the repairer (agent fallback) is wired
    // post-overrides below over the FINAL provider, and the durable runner in the
    // `options.boss` block above — parity with the Worker's EnvConfigRepairWorkflow.
    envConfigRepairJobRepository: sourced(
      'envConfigRepairJobRepository',
      (d) => new DrizzleEnvConfigRepairJobRepository(d),
    ),
    // Ephemeral-environment self-test runs (their own table). The store is wired
    // unconditionally; the environments module builds the service when it + a git provider
    // are present, and the durable runner is wired in the `options.boss` block above.
    environmentTestRunRepository: sourced(
      'environmentTestRunRepository',
      (d) => new DrizzleEnvironmentTestRunRepository(d),
    ),
    // Document sources (Confluence / Notion / GitHub docs): wired from the shared
    // integration providers exactly like the Worker, so a workspace can connect a
    // source and import requirement/PRD/RFC pages as agent context.
    ...selectNodeDocumentsDeps(
      config,
      db,
      githubClient,
      githubInstallationRepository,
      sourced,
      options.secretDelegate,
    ),
    // Ephemeral environments (opt-in): a workspace registers its own environment
    // management API; the tester provisions/destroys per-run environments from it. A
    // trusted in-house adapter can replace the default HTTP provider via the seam.
    // The environment integration scopes its own URL/host policy from
    // `config.environments` inside this selector (separate from the runner pool's).
    ...selectNodeEnvironmentsDeps(config, db),
    // The async container-backed Kubernetes deploy lifecycle (deployJobClient +
    // resolveDeployCloneTarget) — pool-backed by default, overridable by the local facade.
    ...deployDeps,
    // Prompt-fragment library (ADR 0006; opt-in): the managed tenant-scoped catalog
    // of best-practice fragments feeding every agent run, wired exactly like the
    // Worker's selectFragmentLibraryDeps (repos + installation resolver + selector).
    ...selectNodeFragmentLibraryDeps({
      config,
      env,
      db,
      githubClient,
      installations: githubInstallationRepository,
      workspaces: repos.workspaceRepository,
      modelProviderResolver,
    }),
    // Repo-sourced Claude Skills library (ADR 0024; opt-in): the
    // account's catalog of repo-authored skills, wired exactly like the Worker's
    // selectSkillLibraryDeps (account repos + installation resolver).
    ...selectNodeSkillLibraryDeps(
      config,
      db,
      githubClient,
      githubInstallationRepository,
      repos.workspaceRepository,
    ),
    // The foundational-services catalog: ungated (a service's contracts can be uploaded
    // directly, so it is useful without either repo-sourced library) — see the selector's note.
    ...selectNodeFoundationalServiceDeps(
      db,
      githubClient,
      githubInstallationRepository,
      repos.workspaceRepository,
    ),
    // Push-webhook skill-source freshness fan-out (slice 4): resync affected sources via the
    // pg-boss GitHub-sync queue. No boss (pure-logic test) ⇒ no proactive resync; the
    // dispatch-time probe is the freshness backstop.
    enqueueSkillResync: async ({ accountId, sourceId }: SkillSourceResyncRequest) => {
      await gateways.githubWebhook.queueSkillResync(accountId, sourceId)
    },
    // The same fan-out for repo-sourced foundational services.
    enqueueFoundationalResync: async ({ sourceId }: FoundationalSourceResyncRequest) => {
      await gateways.githubWebhook.queueFoundationalResync(sourceId)
    },
    // Slack: an extra notification transport (the channel) + its management module.
    // Default-off; when enabled its channel is composed into `notificationChannel` below
    // alongside the in-app push, identically to the Worker.
    ...slackDeps,
    // Account invitations + per-account email senders (UI-onboarded, DB-stored).
    ...selectNodeEmailInvitationDeps(config, repos),
    // The pipeline-start guard resolves what's configured for a workspace + initiator, under the
    // model preset the run will use (so the guard walks each model's routes in dispatch order).
    resolveProviderCapabilities: (
      workspaceId: string,
      initiatedBy?: string | null,
      modelPresetId?: string,
    ) =>
      resolveWorkspaceCapabilities(
        {
          apiKeys,
          subscriptions,
          personalSubscriptions,
          cloudflareModelsEnabled,
          ...(bedrockModels ? { bedrockModels } : {}),
          baseUrlFor: (provider) => baseUrlForNode(provider, env),
          localModelEndpoints,
          openRouterCatalog,
          accountSettings,
          workspaceAccountOf: (workspaceId) => repos.workspaceRepository.accountOf(workspaceId),
          modelPolicySupported: config.infrastructure?.modelPolicy?.supported ?? false,
          ...(options.caches ? { caches: options.caches } : {}),
          resolvePresetProviderPreference,
        },
        workspaceId,
        initiatedBy,
        modelPresetId,
      ),
    // Real-time push (when a hub is wired) + the composed notification channel (in-app
    // push + Slack). These come AFTER the spreads so the composite replaces the bare
    // Slack channel `slackDeps` set; both are absent (no override) when nothing is wired.
    ...(executionEventPublisher ? { executionEventPublisher } : {}),
    ...(notificationChannel ? { notificationChannel } : {}),
    ...(runLifecycleSink ? { runLifecycleSink } : {}),
    // Run the engine's gate-probe / merge GitHub reads under the run initiator's ambient
    // context, so a per-user PAT (when set) is preferred over the App/env token.
    runInitiatorScope: runWithInitiator,
    // The process-wide cache bag from start() (Redis-notified invalidation when REDIS_URL
    // is set). Absent ⇒ createCore builds bare in-memory defaults.
    ...(options.caches ? { caches: options.caches } : {}),
    ...options.overrides,
  }
}

/**
 * Wire account invitations + per-account email senders for the Node facade (parity
 * with the Worker's `selectEmailInvitationDeps`). Invitations are always available (an
 * invite link works without email); the email-connection store + cipher are wired only
 * when EMAIL is enabled, so an account can onboard a SendGrid/Resend key in the UI and
 * have invites emailed. The provider key is sealed with the shared ENCRYPTION_KEY.
 */
function selectNodeEmailInvitationDeps(
  config: AppConfig,
  repos: ReturnType<typeof createDrizzleRepositories>,
): Partial<CoreDependencies> {
  const deps: Partial<CoreDependencies> = {
    invitationRepository: repos.invitationRepository,
    // Password reset works without email (the link is logged in dev); the system sender
    // below upgrades it to real delivery when configured.
    passwordResetTokenRepository: repos.passwordResetTokenRepository,
    resolveSystemEmailSender: buildSystemEmailSender(config),
    appBaseUrl: config.email.appBaseUrl || undefined,
  }
  if (config.email.enabled && config.email.encryptionKey) {
    deps.emailConnectionRepository = repos.emailConnectionRepository
    deps.emailSecretCipher = new WebCryptoSecretCipher({
      masterKeyBase64: config.email.encryptionKey,
      info: EMAIL_CIPHER_INFO,
    })
  }
  return deps
}

/**
 * Build the deployment-level system email sender (auth emails like password reset) from
 * the env-driven `email.system` config, or undefined when not configured.
 */
function buildSystemEmailSender(
  config: AppConfig,
): (() => Promise<EmailSender | null>) | undefined {
  const system = config.email.system
  if (!system) return undefined
  const sender = createEmailSender({
    provider: system.provider,
    from: system.from,
    sendgrid: system.provider === 'sendgrid' ? { apiKey: system.apiKey } : undefined,
    resend: system.provider === 'resend' ? { apiKey: system.apiKey } : undefined,
  })
  if (!sender) return undefined
  return async () => sender
}

/**
 * The DEPLOYMENT's own document credentials: the half of the document-source wiring that answers
 * to this process's environment rather than to a tenant's stored connection.
 *
 * Separate from {@link selectNodeDocumentsDeps} because it is gated by nothing that one is gated
 * by. `DOCUMENT_SOURCES` says what a workspace may connect, `DOCUMENTS_ENABLED` and the connection
 * encryption key say whether tenant connections are stored at all, and none of the three has any
 * bearing on whether this deployment can read a standard it configured centrally: those credentials
 * live in plaintext environment variables and are never persisted.
 *
 * A source whose variables are present but unusable is WARNED and left unconfigured, which then
 * makes boot validation refuse any code-registered fragment naming it rather than let one fold a
 * stale body. Node boots once, so this is the once-per-process report; the Worker, which has no
 * boot moment, reports at its first-request validation instead.
 */
function selectDeploymentDocumentDeps(): Partial<CoreDependencies> {
  const deployment = resolveDeploymentDocumentResolver(process.env)
  for (const { source, problem } of deployment.problems) {
    logger.warn(
      'Deployment-wide document-source credentials are set but unusable, so this source cannot ' +
        'back a code-registered prompt fragment',
      { source, problem },
    )
  }
  return deployment.resolver ? { deploymentDocumentResolver: deployment.resolver } : {}
}

/**
 * Wire the document-source integration for the Node facade, mirroring the Worker's
 * `selectDocumentsDeps`: the shared `@cat-factory/integrations` provider shells
 * (Confluence/Notion always; GitHub-docs only when a GitHub client is available, since
 * it reuses the workspace's App installation), the Drizzle connection/document repos,
 * and — in `llm` planner mode — the default model ref the doc→board planner runs with
 * (the container's `modelProvider` is shared). Source credentials are encrypted at rest
 * under a documents-scoped HKDF info, keyed by the shared ENCRYPTION_KEY.
 */
function selectNodeDocumentsDeps(
  config: AppConfig,
  db: DrizzleDb,
  githubClient: GitHubClient | undefined,
  installations: GitHubInstallationRepository,
  sourced: <T>(name: string, build: (d: DrizzleDb) => T) => T,
  secretDelegate: CoreDependencies['secretDelegate'],
): Partial<CoreDependencies> {
  // The DEPLOYMENT's own document credentials, read from this process's environment (never from a
  // tenant's stored connection) so a code-registered prompt fragment may name a living standard.
  // Resolved BEFORE, and independently of, every gate below: those govern what a TENANT may
  // connect, and answering both questions from one switch made a deployment that had set its
  // `DOC_SOURCE_*` variables correctly meet a boot refusal naming variables it had already set.
  const deploymentDocuments = selectDeploymentDocumentDeps()
  if (!config.documents.enabled || !config.documents.encryptionKey) return deploymentDocuments
  const providers: DocumentSourceProvider[] = []
  if (config.documents.sources.includes('confluence')) providers.push(new ConfluenceProvider())
  if (config.documents.sources.includes('notion')) providers.push(new NotionProvider())
  // Figma + Zeplin authenticate with a per-workspace PAT (no GitHub client needed), like
  // Notion/Confluence.
  if (config.documents.sources.includes('figma')) providers.push(new FigmaProvider())
  if (config.documents.sources.includes('zeplin')) providers.push(new ZeplinProvider())
  if (config.documents.sources.includes('linear')) providers.push(new LinearDocumentProvider())
  if (config.documents.sources.includes('github') && githubClient) {
    providers.push(new GitHubDocsProvider({ githubClient, installations, logger }))
  }
  if (providers.length === 0) return deploymentDocuments
  // Both repos ride the `pickRepoSource` seam: their rows are org state, and since the connection
  // row now carries its credential bag SEALED (opened below, or by the mothership when this node
  // holds no key), the whole integration is serveable over the persistence RPC.
  const documentConnectionRepository = sourced(
    'documentConnectionRepository',
    (d) => new DrizzleDocumentConnectionRepository(d),
  )
  return {
    ...deploymentDocuments,
    documentSourceProviders: providers,
    documentConnectionRepository,
    documentConnectionStore: createDocumentConnectionStore({
      documentConnectionRepository,
      // Source credentials are sealed at rest under a documents-scoped HKDF info, keyed by the
      // shared ENCRYPTION_KEY.
      secretCipher: new WebCryptoSecretCipher({
        masterKeyBase64: config.documents.encryptionKey,
        info: 'cat-factory:documents',
      }),
      ...(secretDelegate ? { secretDelegate } : {}),
    }),
    documentRepository: new DrizzleDocumentRepository(db),
    ...(config.documents.planner === 'llm'
      ? { documentPlannerModel: config.agents.routing.default.ref }
      : {}),
  }
}

/**
 * Wire the ephemeral-environment integration for the Node facade when enabled,
 * mirroring the Worker's `selectEnvironmentsDeps`: the Drizzle connection + registry repos
 * and the environment-scoped `SecretCipher`. The provider itself is resolved per-workspace
 * from the env-backend registry by the stored `kind` (built-in `manifest`/`kubernetes`, or a
 * deployment's programmatically-registered custom kind), so nothing is injected here.
 * Per-tenant management-API secrets are encrypted at rest with the shared ENCRYPTION_KEY.
 * No key configured → `{}` and the module stays off (there is no separate enable flag).
 */
function selectNodeEnvironmentsDeps(config: AppConfig, db: DrizzleDb): Partial<CoreDependencies> {
  if (!config.environments.encryptionKey) return {}
  // The provider is resolved per-workspace from the env-backend registry by the stored
  // `kind`. Node honors custom-CA / insecure-skip TLS (undici), so a Kubernetes env config
  // with a CA is allowed (environmentCustomTlsSupported defaults to supported).
  const urlPolicy = resolveUrlSafetyPolicy(config.environments)
  return {
    environmentConnectionRepository: new DrizzleEnvironmentConnectionRepository(db),
    environmentRegistryRepository: new DrizzleEnvironmentRegistryRepository(db),
    // The workspace-defined custom-manifest-type catalog is a workspace feature on every facade.
    customManifestTypeRepository: new DrizzleCustomManifestTypeRepository(db),
    secretCipher: new WebCryptoSecretCipher({
      masterKeyBase64: config.environments.encryptionKey,
    }),
    ...(urlPolicy ? { environmentUrlSafetyPolicy: urlPolicy } : {}),
    // Deployment-level, additive extensions to the built-in provisioning-detection conventions.
    ...(config.environments.detectionConventions
      ? { detectionConventions: config.environments.detectionConventions }
      : {}),
  }
}
