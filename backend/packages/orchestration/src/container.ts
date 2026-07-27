import type {} from '@cat-factory/kernel'
import type { AppCaches } from '@cat-factory/kernel'
import { ModuleRegistry } from './container/module-registry.js'
import {
  createDocumentsModule,
  createEnvironmentsModule,
  createTesterQualityReviewer,
  createSlackModule,
  createRiskPoliciesModule,
  createSharedStacksModule,
  createPreflightModule,
  createSandboxModule,
  createReleaseHealthModule,
  createPackageRegistriesModule,
  createPreviewModule,
  createIncidentEnrichmentModule,
  createModelPresetsModule,
  createServiceFragmentDefaultsModule,
} from './container/modules.js'
import { resolveCoreRuntime } from './container/runtime.js'
import { createCoreFoundation } from './container/foundation.js'
import { createEngineCollaborators } from './container/engine-collaborators.js'
import { registerEngineDependentModules } from './container/engine-dependent-modules.js'

import type {} from '@cat-factory/kernel'

import { ServiceMountService } from './modules/services/ServiceMountService.js'

import type { ExecutionEventPublisher } from '@cat-factory/kernel'

import type { WebhookVerifier } from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'
import type { DocumentContentResolver } from '@cat-factory/kernel'

import type {} from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'

import type {} from '@cat-factory/kernel'

import type { BrainstormStage } from '@cat-factory/kernel'

import type {} from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'

import type {} from '@cat-factory/kernel'
import type {} from '@cat-factory/kernel'
import { BoardService } from './modules/board/BoardService.js'
import { ExecutionService } from './modules/execution/ExecutionService.js'
import { PipelineService } from './modules/pipelines/PipelineService.js'
import { WorkspaceService } from '@cat-factory/workspaces'
import { WorkspaceMemberService } from '@cat-factory/workspaces'
import { AccountService } from '@cat-factory/workspaces'
import { UserService } from '@cat-factory/workspaces'
import { InvitationService } from '@cat-factory/workspaces'
import { PasswordResetService } from '@cat-factory/workspaces'
import { EmailConnectionService } from '@cat-factory/integrations'
import { SpendService, DEFAULT_SPEND_PRICING } from '@cat-factory/spend'

import { LlmObservabilityService } from './modules/observability/LlmObservabilityService.js'
import { AgentContextObservabilityService } from './modules/observability/AgentContextObservabilityService.js'
import { SearchQueryObservabilityService } from './modules/observability/SearchQueryObservabilityService.js'
import { PlatformObservabilityService } from './modules/observability/PlatformObservabilityService.js'
import {
  GitHubInstallationService,
  RepoProvisioningService,
  GitHubService,
  GitHubSyncService,
  WebhookService,
  DocumentConnectionService,
  DocumentImportService,
  DocumentPlannerService,
  DocumentLinkService,
  TaskConnectionService,
  TaskImportService,
  TaskLinkService,
  BugIntakeService,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  EnvironmentUserHandlerService,
  RunnerPoolConnectionService,
  PreflightService,
  ProvisioningLogRecorder,
  ProvisioningLogService,
  SharedStackService,
  SlackConnectionService,
  SlackSettingsService,
  SlackMemberMappingService,
  type VcsPatConnectionService,
} from '@cat-factory/integrations'
import { BootstrapService } from './modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from './modules/envConfigRepair/EnvConfigRepairService.js'
import { EnvironmentTestService } from './modules/environments/EnvironmentTestService.js'
import { BoardScanService } from './modules/boardScan/BoardScanService.js'
import { RequirementReviewService } from './modules/requirements/RequirementReviewService.js'
import { KaizenService } from './modules/kaizen/KaizenService.js'
import { ClarityReviewService } from './modules/clarity/ClarityReviewService.js'
import { BrainstormService } from './modules/brainstorm/BrainstormService.js'
import { NotificationService } from './modules/notifications/NotificationService.js'
import { RiskPolicyService } from './modules/merge/RiskPolicyService.js'
import { SandboxService } from './modules/sandbox/SandboxService.js'
import { SandboxRunService } from './modules/sandbox/SandboxRunService.js'
import { WorkspaceSettingsService } from './modules/settings/WorkspaceSettingsService.js'
import { UserSettingsService } from './modules/settings/UserSettingsService.js'
import { ReleaseHealthService } from './modules/releaseHealth/ReleaseHealthService.js'
import { PackageRegistryService } from './modules/packageRegistries/PackageRegistryService.js'
import { PreviewService } from './modules/preview/PreviewService.js'
import { IncidentEnrichmentService } from './modules/incidentEnrichment/IncidentEnrichmentService.js'
import type { AccountSettingsService } from '@cat-factory/integrations'
import {
  ModelPresetService,
  resolvePresetModelForKind,
} from './modules/modelPresets/ModelPresetService.js'
import { ServiceFragmentDefaultsService } from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import { RecurringPipelineService } from './modules/recurring/RecurringPipelineService.js'
import { TrackerSettingsService } from './modules/recurring/TrackerSettingsService.js'
import { InitiativeService } from './modules/initiative/InitiativeService.js'
import { InitiativeLoopService } from './modules/initiative/InitiativeLoopService.js'
import { type AgentKindRegistry } from '@cat-factory/agents'
import {
  createFragmentLibraryModule,
  createSkillLibraryModule,
} from './container-content-libraries.js'
import type { FragmentLibraryModule, SkillLibraryModule } from './container-content-libraries.js'
import type {
  GateRegistry,
  InitiativePresetRegistry,
  PipelineRegistry,
  TaskTypeRegistry,
} from '@cat-factory/kernel'

// Composition root for the domain layer. The worker's infrastructure builds the
// concrete ports (D1 repositories, crypto id/rng, the AI agent executor) and
// hands them here; `createCore` wires the module services together in dependency
// order and returns them. This is the framework-agnostic equivalent of the
// template's per-module DI config, minus the awilix machinery.

// The `createCore` dependency contract lives in its own module (it is ~815 lines of pure
// declaration); re-exported here so every existing import site is unchanged.
export type { CoreDependencies } from './container/dependencies.js'
import type { CoreDependencies } from './container/dependencies.js'

/** The GitHub integration's services, present only when the app is configured. */
export interface GitHubModule {
  installationService: GitHubInstallationService
  syncService: GitHubSyncService
  webhookService: WebhookService
  service: GitHubService
  webhookVerifier: WebhookVerifier
  /**
   * Direct repo creation (privileged App tier, ADR 0005). Present only when a
   * privileged provisioning client is wired; absent → creation stays manual.
   */
  provisioningService?: RepoProvisioningService
}

/** The document-source integration's services, present only when configured. */
export interface DocumentsModule {
  connectionService: DocumentConnectionService
  importService: DocumentImportService
  plannerService: DocumentPlannerService
  linkService: DocumentLinkService
  /** Live read seam for document-backed prompt fragments (re-resolved at run time). */
  contentResolver: DocumentContentResolver
}

/** The task-source integration's services, present only when configured. */
export interface TasksModule {
  connectionService: TaskConnectionService
  importService: TaskImportService
  linkService: TaskLinkService
  /**
   * The recurring `bug-intake` engine step's read-and-claim helper (present only when a
   * schedule repository is wired). Injected into the execution engine so the `bug-intake`
   * step can pull one matching issue from the schedule's tracker board and claim it.
   */
  bugIntakeService?: BugIntakeService
}

/** The environment integration's services, present only when configured. */
export interface EnvironmentsModule {
  connectionService: EnvironmentConnectionService
  provisioningService: EnvironmentProvisioningService
  teardownService: EnvironmentTeardownService
  /**
   * The per-USER infra handler override store (local mode). Present only when the facade
   * wired `environmentUserHandlerRepository` (the local facade does; Worker/Node don't), so
   * the per-user-override controller 503s and provisioning ignores user overrides elsewhere.
   */
  userHandlerService?: EnvironmentUserHandlerService
  /** The durable env-config-repair service, present only when its deps are wired. */
  envConfigRepair?: EnvConfigRepairModule
  /**
   * The ephemeral-environment self-test service, present only when its run repository +
   * `resolveRunRepoContext` are wired (needs a git provider to create/delete the branch).
   */
  environmentTest?: EnvironmentTestService
}

/** The self-hosted runner-pool integration's services, present only when configured. */
export interface RunnersModule {
  connectionService: RunnerPoolConnectionService
}

/** The provisioning event-log read service, present only when its store is wired. */
export interface ProvisioningLogsModule {
  service: ProvisioningLogService
}

/** The repo-bootstrap feature's service, present only when its repositories exist. */
export interface BootstrapModule {
  service: BootstrapService
}

/** The env-config-repair feature's durable service, present only when its deps are wired. */
interface EnvConfigRepairModule {
  service: EnvConfigRepairService
}

/** The requirements-review feature's service, present only when its repository is wired. */
export interface RequirementsModule {
  service: RequirementReviewService
}

/** The Kaizen feature's service, present only when its repositories are wired. */
export interface KaizenModule {
  service: KaizenService
}

/** The clarity-review feature's service, present only when its repository is wired. */
export interface ClarityModule {
  service: ClarityReviewService
}

/** The brainstorm feature's per-stage services, present only when its repository is wired. */
export interface BrainstormModule {
  services: Record<BrainstormStage, BrainstormService>
}

/** The notifications feature's service, present only when its repository is wired. */
export interface NotificationsModule {
  service: NotificationService
}

/** The post-release-health (Datadog) settings service, present only when wired. */
export interface ReleaseHealthModule {
  service: ReleaseHealthService
}

/** The private package-registry settings service, present only when wired. */
export interface PackageRegistriesModule {
  service: PackageRegistryService
}

/** The browsable-frontend-preview service, present only when a preview transport is wired. */
export interface PreviewModule {
  service: PreviewService
}

/** The incident-enrichment (PagerDuty + incident.io) settings service, present only when wired. */
export interface IncidentEnrichmentModule {
  service: IncidentEnrichmentService
}

/** The per-account deployment-settings service, present only when wired (facade-built). */
interface AccountSettingsModule {
  service: AccountSettingsService
}

/** The Slack integration's services, present only when its repositories are wired. */
export interface SlackModule {
  connectionService: SlackConnectionService
  settingsService: SlackSettingsService
  memberMappingService: SlackMemberMappingService
}

/** The merge-preset feature's service, present only when its repository is wired. */
export interface RiskPoliciesModule {
  service: RiskPolicyService
}

/** The shared-stacks feature's service, present only when its repository is wired. */
export interface SharedStacksModule {
  service: SharedStackService
}

/** The preflight feature's service, present only when the host-probe seam is wired (local facade). */
export interface PreflightsModule {
  service: PreflightService
}

/** The Sandbox feature's services, present only when its repositories are wired. */
export interface SandboxModule {
  /** Management CRUD (prompt versions, fixtures, experiments). */
  service: SandboxService
  /** The run-driver + judge (`launch` an experiment). */
  runService: SandboxRunService
}

/** The workspace-settings feature's service, present only when its repository is wired. */
export interface WorkspaceSettingsModule {
  service: WorkspaceSettingsService
}

/** The per-user-settings feature's service, present only when its repository is wired. */
interface UserSettingsModule {
  service: UserSettingsService
}

/** The model-preset feature's service, present only when its repository is wired. */
export interface ModelPresetsModule {
  service: ModelPresetService
}

/** The default service-fragment feature's service, present only when its repository is wired. */
export interface ServiceFragmentDefaultsModule {
  service: ServiceFragmentDefaultsService
}

/** The recurring-pipeline feature's service, present only when its repository is wired. */
export interface RecurringModule {
  service: RecurringPipelineService
}

/** The initiatives feature's service + execution loop, present only when its repository is wired. */
export interface InitiativesModule {
  service: InitiativeService
  /** The execution loop (slice 3): tick/runDue driven by the cron seams + terminal pokes. */
  loop: InitiativeLoopService
}

/** The issue-tracker-settings feature's service, present only when its repository is wired. */
export interface TrackerModule {
  service: TrackerSettingsService
}

// The two content-library module shapes (`FragmentLibraryModule` / `SkillLibraryModule`) live
// beside their factories in `container-content-libraries.js` for file-size hygiene; re-exported
// here so existing importers are unaffected.
export type { FragmentLibraryModule, SkillLibraryModule }

/**
 * The always-present core services every facade wires — the composition root's SPINE. These
 * are unconditional (no `?`): a `Core` never lacks them. Split out from the optional modules
 * ({@link OptionalCoreModules}) so the two concerns are named separately and the domain
 * container (`createCore`) can assemble the optional set through a {@link ModuleRegistry}
 * while the spine — which carries the genuine circular late-bindings — stays explicit.
 */
export interface CoreSpine {
  workspaceService: WorkspaceService
  accountService: AccountService
  userService: UserService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
  spendService: SpendService
  /**
   * The app-owned agent-kind registry the engine resolved (the facade's injected instance,
   * else the built-ins-only default). Re-exposed so the HTTP layer's workspace-snapshot
   * projection reads the SAME instance the engine + executors use.
   */
  agentKindRegistry: AgentKindRegistry
  /**
   * The app-owned polling-gate registry the engine resolved (the facade's injected instance,
   * with the built-in `@cat-factory/gates` suite installed, else the empty default). Re-exposed
   * so the facade passes the SAME instance to `validateRegistrations` at boot.
   */
  gateRegistry: GateRegistry
  /**
   * The app-owned pipeline registry the engine resolved (the facade's injected instance, else the
   * empty default). Re-exposed so the facade passes the SAME instance to `validateRegistrations` at
   * boot (a registered pipeline naming a nonexistent kind fails fast).
   */
  pipelineRegistry: PipelineRegistry
  /**
   * The app-owned custom task-type registry the engine resolved (the facade's injected instance,
   * else the empty default). Re-exposed so the HTTP layer's workspace-snapshot projection
   * (`customTaskTypes`) reads the SAME instance, and the facade passes it to `validateRegistrations`.
   */
  taskTypeRegistry: TaskTypeRegistry
  /**
   * The app-owned initiative-preset registry the engine resolved (the facade's injected instance,
   * else the built-ins-only default). Re-exposed so the HTTP layer's workspace-snapshot descriptors
   * + the preset probe read the SAME instance the initiative services use.
   */
  initiativePresetRegistry: InitiativePresetRegistry
  /**
   * The real-time event publisher the engine pushes transitions through. Exposed so
   * the runtime-neutral LLM proxy can push a compact `llmCall` activity event per
   * model call (live "Model activity", independent of the durable driver). Defaults
   * to {@link NoopEventPublisher}; a facade with a real-time transport injects its own.
   */
  executionEventPublisher: ExecutionEventPublisher
  /**
   * The app-owned cache bag (built by the facade via `createAppCaches`, or a bare in-memory
   * default when a harness passes none). Exposed so the shared controllers can read a cached
   * slice (the `/models` catalog's account-policy read) and invalidate one after a write (the
   * account-settings update drops `accountModelPolicy`). Always present.
   */
  caches: AppCaches
}

/**
 * The OPTIONAL modules the domain container wires only when their prerequisites are configured
 * — every feature that can be absent (its repositories/cipher/provider unwired). Assembled by
 * `createCore` through a {@link ModuleRegistry}: each key is `build`-declared once and emitted
 * in a single place, so a feature is present iff its factory yielded a value. The
 * {@link ModuleRegistry} reads these keys, so keep the two in step.
 */
export interface OptionalCoreModules {
  /**
   * Workspace-RBAC roster + access-mode management (workspace-rbac initiative). Present only
   * when the workspace-member repository is wired (both facades wire it); absent ⇒ the members
   * controller reports 503. Every roster/access-mode write invalidates the `workspaceAccess` cache.
   */
  workspaceMemberService?: WorkspaceMemberService
  /** Present only when the invitation repository is wired (see CoreDependencies). */
  invitations?: InvitationService
  /** Present only when the password-reset token repository is wired. */
  passwordReset?: PasswordResetService
  /** Present only when the email-connection repository + cipher are wired. */
  email?: EmailConnectionService
  /** Present only when the LLM-metric repository is wired (see CoreDependencies). */
  llmObservability?: LlmObservabilityService
  /** Present only when the platform-metrics rollup repository is wired (see CoreDependencies). */
  platformObservability?: PlatformObservabilityService
  /** Present only when the agent-context snapshot repository is wired (see CoreDependencies). */
  agentContextObservability?: AgentContextObservabilityService
  /** Present only when the agent-search-query repository is wired (see CoreDependencies). */
  searchQueryObservability?: SearchQueryObservabilityService
  /** Present only when the GitHub integration is configured (see CoreDependencies). */
  github?: GitHubModule
  /** Present only when a facade wired the per-workspace VCS PAT connect service (GitLab connect). */
  vcsConnectionService?: VcsPatConnectionService
  /** Present only when the document-source integration is configured (see CoreDependencies). */
  documents?: DocumentsModule
  /** Present only when the task-source integration is configured (see CoreDependencies). */
  tasks?: TasksModule
  /** Present only when the environment integration is configured (see CoreDependencies). */
  environments?: EnvironmentsModule
  /** Present only when the self-hosted runner-pool integration is configured. */
  runners?: RunnersModule
  /** Present only when the provisioning event-log store is wired (see CoreDependencies). */
  provisioningLogs?: ProvisioningLogsModule
  /** Present only when the repo-bootstrap repositories are wired (see CoreDependencies). */
  bootstrap?: BootstrapModule
  /** Present only when the env-config-repair deps are wired (see CoreDependencies). */
  envConfigRepair?: EnvConfigRepairModule
  /** Present only when the requirements-review repository is wired (see CoreDependencies). */
  requirements?: RequirementsModule
  /** Present only when the Kaizen repositories are wired (see CoreDependencies). */
  kaizen?: KaizenModule
  /** Present only when the clarity-review repository is wired (see CoreDependencies). */
  clarity?: ClarityModule
  /** Present only when the brainstorm repository is wired (see CoreDependencies). */
  brainstorm?: BrainstormModule
  /** Present only when the notifications repository is wired (see CoreDependencies). */
  notifications?: NotificationsModule
  /** Present only when the Datadog connection + release-health config repos + cipher are wired. */
  releaseHealth?: ReleaseHealthModule
  /** Present only when the package-registry connection repo + cipher are wired. */
  packageRegistries?: PackageRegistriesModule
  /** Present only when a preview transport + job builder are wired (local/node — see CoreDependencies). */
  preview?: PreviewModule
  /** Present only when the incident-enrichment connection repo + cipher are wired. */
  incidentEnrichmentSettings?: IncidentEnrichmentModule
  /** Present only when the per-account settings service is wired (facade-built). */
  accountSettings?: AccountSettingsModule
  /** Present only when the Slack repositories + cipher are wired (see CoreDependencies). */
  slack?: SlackModule
  /** Present only when the merge-preset repository is wired (see CoreDependencies). */
  riskPolicies?: RiskPoliciesModule
  /** Present only when the shared-stack repository is wired (see CoreDependencies). */
  sharedStacks?: SharedStacksModule
  /** Present only when the host-probe seam is wired (local facade — see CoreDependencies). */
  preflight?: PreflightsModule
  /** Present only when the Sandbox repositories are wired (see CoreDependencies). */
  sandbox?: SandboxModule
  /** Present only when the workspace-settings repository is wired (see CoreDependencies). */
  settings?: WorkspaceSettingsModule
  /** Present only when the per-user-settings repository is wired (see CoreDependencies). */
  userSettings?: UserSettingsModule
  /** Present only when the model-preset repository is wired (see CoreDependencies). */
  modelPresets?: ModelPresetsModule
  /** Present only when the service-fragment-defaults repository is wired (see CoreDependencies). */
  serviceFragmentDefaults?: ServiceFragmentDefaultsModule
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
  /** Present only when the repo-sourced Claude Skills library is configured (see CoreDependencies). */
  skillLibrary?: SkillLibraryModule
  /** Present only when the initiative repository is wired (see CoreDependencies). */
  initiatives?: InitiativesModule
  /** Present only when the recurring-pipeline repository is wired (see CoreDependencies). */
  recurring?: RecurringModule
  /** Present only when the tracker-settings repository is wired (see CoreDependencies). */
  tracker?: TrackerModule
  /** Present only when the service + mount repositories are wired (in-org sharing). */
  services?: ServicesModule
}

/**
 * The assembled domain container: the always-present {@link CoreSpine} plus the
 * conditionally-wired {@link OptionalCoreModules}. Shape-identical to the flat interface it
 * replaced, so every consumer is unchanged.
 */
export interface Core extends CoreSpine, OptionalCoreModules {}

export interface ServicesModule {
  service: ServiceMountService
}

/** Assemble the in-org service-sharing module when its repositories are wired. */

/**
 * Register the optional modules whose only wiring is `dependencies` (no captured local is
 * consumed downstream). Grouped so the composition root stays under the statement ceiling; the
 * registration order relative to the surrounding builds is preserved.
 */
function registerStandaloneModules(modules: ModuleRegistry, dependencies: CoreDependencies): void {
  modules.build('releaseHealth', () => createReleaseHealthModule(dependencies))
  modules.build('packageRegistries', () => createPackageRegistriesModule(dependencies))
  modules.build('preview', () => createPreviewModule(dependencies))
  modules.build('incidentEnrichmentSettings', () => createIncidentEnrichmentModule(dependencies))
  modules.build('modelPresets', () => createModelPresetsModule(dependencies))
  modules.build('serviceFragmentDefaults', () => createServiceFragmentDefaultsModule(dependencies))
}

export function createCore(dependencies: CoreDependencies): Core {
  const {
    agentKindRegistry,
    gateRegistry,
    stepResolverRegistry,
    providerRegistry,
    pipelineRegistry,
    taskTypeRegistry,
    initiativePresetRegistry,
    workRunner,
    executionEventPublisher,
    caches,
  } = resolveCoreRuntime(dependencies)
  // The optional-module registry: every feature that is wired only when its prerequisites are
  // configured is `build`-declared through this, instead of a scattered `const x = createX(...)`
  // + a matching `...(x ? { x } : {})` return spread. Registration order below IS dependency
  // order: `build` returns the value, so a module consumed downstream is kept in a local and
  // threaded into the later factories that need it (`modules.get(...)` is there for a reader that
  // holds no local). The whole set is emitted in one place via `...modules.assemble()` at the
  // return. The core spine (below) stays explicit —
  // it carries the genuine circular late-bindings (account ⇄ spend, engine ⇄ initiative loop).
  const modules = new ModuleRegistry()
  // Late-bound: accountService reads the below-built spendService via `getSpendService`.
  let spendServiceRef: SpendService | undefined
  // The foundation slice (notifications/settings, board/workspace/account/user + the account-
  // onboarding modules) is built up-front as a cohesive collaborator; see container/foundation.ts.
  const { notifications, settings, boardService, workspaceService, accountService, userService } =
    createCoreFoundation({
      dependencies,
      modules,
      caches,
      executionEventPublisher,
      taskTypeRegistry,
      pipelineRegistry,
      getSpendService: () => spendServiceRef,
    })
  const pipelineService = new PipelineService({ ...dependencies, pipelineRegistry })
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
    workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
    accountRepository: dependencies.accountRepository,
    userSettingsRepository: dependencies.userSettingsRepository,
    dynamicPricesFor: dependencies.dynamicModelPricesFor,
    // The pricing overlay reads the workspace-settings row through the shared slice
    // (invalidated by WorkspaceSettingsService.update); the two budget-limit slices are
    // invalidated by the account/user budget-change callbacks below.
    workspaceSettingsCache: caches.workspaceSettings,
    accountBudgetLimitCache: caches.accountBudgetLimit,
    userBudgetLimitCache: caches.userBudgetLimit,
  })
  spendServiceRef = spendService
  modules.build('userSettings', () =>
    dependencies.userSettingsRepository
      ? {
          service: new UserSettingsService({
            userSettingsRepository: dependencies.userSettingsRepository,
            onUserBudgetChanged: (userId) => spendService.invalidateUserLimit(userId),
            // Reject a user budget above the operator cap on write.
            resolveUserBudgetCap: () => spendService.budgetCaps().userMonthlyLimitMax,
          }),
        }
      : undefined,
  )
  const llmObservability = modules.build('llmObservability', () =>
    dependencies.llmCallMetricRepository
      ? new LlmObservabilityService({
          llmCallMetricRepository: dependencies.llmCallMetricRepository,
          idGenerator: dependencies.idGenerator,
          clock: dependencies.clock,
          recordPrompts: dependencies.recordLlmPrompts ?? true,
          traceSink: dependencies.llmTraceSink,
          workspaceSettingsRepository: dependencies.workspaceSettingsRepository,
          workspaceSettingsCache: caches.workspaceSettings,
        })
      : undefined,
  )
  modules.build('platformObservability', () =>
    dependencies.platformMetricsRepository
      ? new PlatformObservabilityService({
          platformMetricsRepository: dependencies.platformMetricsRepository,
          clock: dependencies.clock,
        })
      : undefined,
  )
  // The provisioning event log lives in a separate high-churn store. When its
  // repository is wired, build a best-effort recorder (threaded into the env
  // services) + the read service (exposed for the logs controller). The container
  // transports are wrapped with their own recorder in each facade's resolveTransport.
  const provisioningLogRecorder = dependencies.provisioningLogRepository
    ? new ProvisioningLogRecorder({
        repository: dependencies.provisioningLogRepository,
        idGenerator: dependencies.idGenerator,
        clock: dependencies.clock,
      })
    : undefined
  modules.build('provisioningLogs', () =>
    dependencies.provisioningLogRepository
      ? {
          service: new ProvisioningLogService({
            repository: dependencies.provisioningLogRepository,
          }),
        }
      : undefined,
  )
  // Built before the shared-stacks + environments modules so a compose stack recipe's
  // `prerequisites` (and a shared stack's own prerequisites) are re-run at provision / bring-up
  // start through this service. The host probes exist only on the local facade; absent ⇒ a recipe /
  // stack that declares prerequisites fails loudly (the preflight API 503s too).
  const preflight = modules.build('preflight', () => createPreflightModule(dependencies))
  // Built before the environments module so a compose stack recipe's `sharedStackRefs` can be
  // brought up (provider-before-consumer) through this service during provisioning. Persistence is
  // runtime-symmetric (present on every facade); the lifecycle only runs where a host daemon is
  // wired (`composeRuntime` — the local facade), else `ensureRefsUp` returns a clean error. It gets
  // the preflight service so a shared stack re-checks its own machine prerequisites at bring-up.
  const sharedStacks = modules.build('sharedStacks', () =>
    createSharedStacksModule(dependencies, preflight?.service),
  )
  const environments = modules.build('environments', () =>
    createEnvironmentsModule(
      dependencies,
      provisioningLogRecorder,
      executionEventPublisher,
      sharedStacks?.service,
      preflight?.service,
    ),
  )
  // Built before the fragment library so a document-backed fragment can re-resolve
  // its linked Confluence/Notion/GitHub page through the document module's reader.
  const documents = modules.build('documents', () =>
    createDocumentsModule(dependencies, boardService),
  )
  const fragmentLibrary = modules.build('fragmentLibrary', () =>
    createFragmentLibraryModule(dependencies, documents?.contentResolver, caches),
  )
  const skillLibrary = modules.build('skillLibrary', () =>
    createSkillLibraryModule(dependencies, caches),
  )

  // Reconciles a `blueprints` step's decomposition onto the board. Needs only the
  // board service + block repository (both always present), so it is wired
  // unconditionally — there is no standalone scan command or persisted blueprint store.
  const blueprintReconciler = new BoardScanService({
    boardService,
    blockRepository: dependencies.blockRepository,
  })
  // `notifications` + `settings` are built up-front (near the board service) so the friction
  // guard, the per-service task limit, and the escalation sweep can read them.
  modules.build('slack', () => createSlackModule(dependencies))
  modules.build('riskPolicies', () => createRiskPoliciesModule(dependencies, caches))
  modules.build('sandbox', () => createSandboxModule(dependencies, agentKindRegistry))
  registerStandaloneModules(modules, dependencies)
  // The collaborators the engine needs BEFORE it is constructed (initiative + interview
  // services, the requirements / clarity / brainstorm / doc-interview / fork-chat / kaizen
  // review surfaces, and the task module), plus the late-bound initiative-loop poke. Lifted
  // into `container/engine-collaborators.ts` for the per-function line budget; the
  // registration order — which IS dependency order for the module registry — is preserved.
  const {
    initiativeService,
    initiativeInterviewService,
    requirements,
    docInterview,
    forkChat,
    clarity,
    brainstorm,
    kaizen,
    tasks,
    pokeInitiativeLoop,
    setInitiativeLoop,
  } = createEngineCollaborators({
    dependencies,
    modules,
    initiativePresetRegistry,
    executionEventPublisher,
    notifications,
    fragmentLibrary,
    boardService,
  })

  const executionService = new ExecutionService({
    ...dependencies,
    agentKindRegistry,
    gateRegistry,
    stepResolverRegistry,
    providerRegistry,
    initiativePresetRegistry,
    workRunner,
    executionEventPublisher,
    boardService,
    pokeInitiativeLoop,
    bugIntakeService: tasks?.bugIntakeService,
    spendService,
    // Read-through slice for `resolveRiskPolicy` (the merge preset re-read on every gate
    // evaluation); `RiskPolicyService` invalidates it on every preset write.
    riskPolicyCache: caches.riskPolicy,
    // Route runtime fragment-id resolution through the merged tenant catalog (so
    // managed + document-backed fragments reach a run), present only when the
    // library is configured; otherwise the engine falls back to the static pool.
    fragmentResolver: fragmentLibrary?.libraryService,
    // Route a `skill` step's skill resolution (instructions + resource bodies at the pinned
    // commit) through the skill library, present only when it's configured; a skill step
    // dispatched without it fails loudly rather than running blank.
    skillResolver: skillLibrary?.runResolver,
    // Canonicalise a URL pasted into a block description to the document's stable
    // (source, externalId) via the providers' parseRef, so a Figma/Notion/etc. link
    // auto-matches its imported page even with a title segment or tracking params the
    // stored canonical url omits. Absent providers → undefined (url-string match only).
    documentUrlResolver: dependencies.documentSourceProviders?.length
      ? (url: string) => {
          for (const provider of dependencies.documentSourceProviders!) {
            const externalId = provider.parseRef(url)
            if (externalId) return { source: provider.kind, externalId }
          }
          return null
        }
      : undefined,
    requirementReviewService: requirements?.service,
    docInterviewService: docInterview,
    forkChatService: forkChat,
    // The test quality-control companion's inline reviewer, resolved like every other inline
    // review (block pin → workspace preset → routing default). Built only when a model
    // provider is available; absent → the Tester gate's QC step is a pass-through.
    testerQualityReviewer:
      dependencies.testerQualityReviewer ?? createTesterQualityReviewer(dependencies),
    clarityReviewService: clarity?.service,
    brainstormServices: brainstorm?.services,
    kaizenScheduler: kaizen?.service,
    environmentProvisioning: environments?.provisioningService,
    resolveTestSecretRefs: dependencies.resolveTestSecretRefs,
    resolveValidationChecks: dependencies.resolveValidationChecks,
    environmentTeardown: environments?.teardownService,
    branchUpdater: dependencies.branchUpdater,
    blueprintReconciler,
    initiativeService,
    initiativeRepository: dependencies.initiativeRepository,
    initiativeInterviewService,
    notificationService: notifications?.service,
    workspaceSettingsService: settings?.service,
    llmObservability,
    ticketTrackerProvider: dependencies.ticketTrackerProvider,
    issueWriteback: dependencies.issueWritebackProvider,
    // Let the personal-credential gate + start guard resolve the model the same way
    // dispatch does, so a run whose block has no pin but resolves (via its preset) to an
    // individual-usage model is still gated up-front. Reuses the model-preset repository.
    resolveWorkspaceModelDefault: dependencies.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            dependencies.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })

  // The modules that depend on the assembled engine (they drive `executionService`, or feed the
  // late-bound initiative loop). Lifted into `container/engine-dependent-modules.ts` for the
  // per-function line budget; it registers in the SAME order and late-binds the initiative loop
  // through `setInitiativeLoop` so the terminal poke above resolves it.
  registerEngineDependentModules({
    dependencies,
    modules,
    caches,
    executionEventPublisher,
    executionService,
    environments,
    tasks,
    notifications,
    initiativeService,
    setInitiativeLoop,
  })

  // The always-present spine, plus every optional module the registry assembled in ONE place
  // (unwired keys absent) — replacing the ~40 hand-written `...(x ? { x } : {})` return spreads.
  return {
    caches,
    workspaceService,
    accountService,
    userService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    agentKindRegistry,
    gateRegistry,
    pipelineRegistry,
    taskTypeRegistry,
    initiativePresetRegistry,
    executionEventPublisher,
    ...modules.assemble(),
  }
}
