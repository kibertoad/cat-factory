import type {} from '@cat-factory/kernel'
import type { AppCaches, Logger, OperationalMetrics } from '@cat-factory/kernel'
import { ModuleRegistry } from './container/module-registry.js'
import {
  createSlackModule,
  createMergeTrackRecordModule,
  createRiskPoliciesModule,
  createSandboxModule,
  createReleaseHealthModule,
  createPackageRegistriesModule,
  createPreviewModule,
  createIncidentEnrichmentModule,
  createAgentPromptsModule,
  createWorkspaceAgentSettingsModule,
  createModelPresetsModule,
  createConsensusGroupsModule,
  createServiceFragmentDefaultsModule,
} from './container/modules.js'
import { resolveCoreRuntime } from './container/runtime.js'
import { createPlatformModules } from './container/platform-modules.js'
import { createCoreFoundation } from './container/foundation.js'
import { createEngineCollaborators } from './container/engine-collaborators.js'
import { registerEngineDependentModules } from './container/engine-dependent-modules.js'
import { buildExecutionService } from './container/execution-service.js'

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

import type { EnvironmentHandlerSeeder, SharedStackSeeder } from '@cat-factory/kernel'

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
import { ReportsService } from './modules/reports/ReportsService.js'
import { RunDebugService } from './modules/debug/RunDebugService.js'
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
  BugHuntService,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  EnvironmentUserHandlerService,
  RunnerPoolConnectionService,
  ProvisioningLogService,
  type VcsPatConnectionService,
} from '@cat-factory/integrations'
import { BootstrapService } from './modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from './modules/envConfigRepair/EnvConfigRepairService.js'
import { EnvironmentTestService } from './modules/environments/EnvironmentTestService.js'
import { BoardScanService } from './modules/boardScan/BoardScanService.js'
import { TutorialProgressService } from './modules/tutorial/TutorialProgressService.js'
import { TutorialTelemetryService } from './modules/tutorial/TutorialTelemetryService.js'
import { UserSettingsService } from './modules/settings/UserSettingsService.js'
import { type AgentKindRegistry } from '@cat-factory/agents'
import type {
  FoundationalServiceModule,
  FragmentLibraryModule,
  SkillLibraryModule,
} from './container-content-libraries.js'
import type {
  BinaryGeneratorRegistry,
  BinaryGeneratorSource,
  FoundationalServiceRegistry,
  GateRegistry,
  JudgeRegistry,
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
  /**
   * The interactive bug hunt's read-and-rank helper — the human-driven dual of `bug-intake`.
   * Always present when task sources are configured (unlike `bugIntakeService`, it needs no
   * schedule repository); its RANKING degrades on its own when no model is wired, so the
   * board scan stays available on a model-less deployment.
   */
  bugHuntService: BugHuntService
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

// The small single-/few-service module SHAPES live beside nothing in particular — they are pure
// declarations — so they are grouped in `container/module-shapes.ts` for file-size hygiene (the
// same treatment `container-content-libraries.js` already gives the two library shapes) and
// re-exported here so existing importers are unaffected. `container/modules.ts` imports them from
// that module directly, which also drops its type-import back-edge onto this file.
import type {
  AccountSettingsModule,
  AgentPromptsModule,
  BrainstormModule,
  ClarityModule,
  IncidentEnrichmentModule,
  InitiativesModule,
  KaizenModule,
  MergeTrackRecordModule,
  ModelPresetsModule,
  ConsensusGroupsModule,
  NotificationsModule,
  PackageRegistriesModule,
  PreflightsModule,
  PreviewModule,
  RecurringModule,
  ReleaseHealthModule,
  RequirementsModule,
  RiskPoliciesModule,
  SandboxModule,
  ServiceFragmentDefaultsModule,
  SharedStacksModule,
  SlackModule,
  TrackerModule,
  TrackerWebhookModule,
  TutorialProgressModule,
  UserSettingsModule,
  WorkspaceAgentSettingsModule,
  WorkspaceSettingsModule,
} from './container/module-shapes.js'
export type {
  AccountSettingsModule,
  AgentPromptsModule,
  BrainstormModule,
  ClarityModule,
  IncidentEnrichmentModule,
  InitiativesModule,
  KaizenModule,
  MergeTrackRecordModule,
  ModelPresetsModule,
  ConsensusGroupsModule,
  NotificationsModule,
  PackageRegistriesModule,
  PreflightsModule,
  PreviewModule,
  RecurringModule,
  ReleaseHealthModule,
  RequirementsModule,
  RiskPoliciesModule,
  SandboxModule,
  ServiceFragmentDefaultsModule,
  SharedStacksModule,
  SlackModule,
  TrackerModule,
  TrackerWebhookModule,
  TutorialProgressModule,
  UserSettingsModule,
  WorkspaceAgentSettingsModule,
  WorkspaceSettingsModule,
} from './container/module-shapes.js'

// The two content-library module shapes (`FragmentLibraryModule` / `SkillLibraryModule`) live
// beside their factories in `container-content-libraries.js` for file-size hygiene; re-exported
// here so existing importers are unaffected.
export type { FoundationalServiceModule, FragmentLibraryModule, SkillLibraryModule }

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
   * The app-owned JUDGE registry the engine resolved (the facade's injected instance, else the
   * empty default). Re-exposed so the HTTP layer's workspace-snapshot projection surfaces a
   * registered judge as a palette block, and the facade passes the SAME instance to
   * `validateRegistrations` at boot.
   */
  judgeRegistry: JudgeRegistry
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
   * The app-owned foundational-service registry the engine resolved (the facade's injected
   * instance, else the empty default) — the catalog's `builtin` tier. Re-exposed so the facade
   * passes the SAME instance to `validateRegistrations` at boot, where a malformed definition or
   * an unparseable contract document fails the deployment instead of reaching an Architect.
   */
  foundationalServiceRegistry: FoundationalServiceRegistry
  /**
   * The app-owned generative-binary-integration registry the engine resolved (the facade's
   * injected instance, else the empty default). Re-exposed for the SAME reason as its neighbour:
   * the facade passes this instance to `validateRegistrations` at boot, so a malformed
   * integration fails the deployment instead of a dispatch that can generate nothing.
   */
  binaryGeneratorRegistry: BinaryGeneratorRegistry
  /**
   * Where a RUN's generative integrations are READ from — this process's own registry above,
   * unless a mothership-mode node injected the remote source. Re-exposed because the HTTP layer
   * needs the SAME answer: the pipeline builder's picker is fed from the workspace snapshot, and
   * a picker offering ids from a different set than admission resolves against is the exact
   * drift this seam exists to remove — just moved one surface along.
   */
  binaryGenerators: BinaryGeneratorSource
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
  /**
   * The resolved structured logger (`backend/docs/logging.md`) — the facade's pino instance,
   * or `noopLogger` when none was injected. Exposed so the shared controllers and the runtime
   * sweepers log through the SAME instance the domain services do, instead of importing the
   * module-level singleton and diverging on bound fields. Always present.
   */
  logger: Logger
  /**
   * The resolved operational-metrics collector (kernel `ports/operational-metrics.ts`).
   * Exposed for the same reason `logger` is: the facade's sweepers and its metric flush must
   * count into the SAME instance the domain services do, and reaching it off the container is
   * what guarantees that rather than hoping two composition roots built one object. Always
   * present (`CoreDependencies.operationalMetrics` is required).
   */
  operationalMetrics: OperationalMetrics
  /**
   * Counts in-app tutorial funnel events. On the SPINE rather than in the optional set, and
   * unconditional, for the same reason `operationalMetrics` is required: an un-wired counter
   * reports a permanent zero, which reads as "nobody takes the tutorial" instead of as "nobody
   * wired this". It needs no repository — the events are counted and discarded — so it is
   * available even on a facade with no per-user progress store.
   *
   * A single instance per container because it holds the per-process distinct-dimension cap that
   * keeps a browser-supplied tour id from minting unbounded metric series.
   */
  tutorialTelemetry: TutorialTelemetryService
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
  /** Present only when the reports rollup repository is wired (see CoreDependencies). */
  reports?: ReportsService
  /** Present only when the agent-context snapshot repository is wired (see CoreDependencies). */
  agentContextObservability?: AgentContextObservabilityService
  /** Present only when the agent-search-query repository is wired (see CoreDependencies). */
  searchQueryObservability?: SearchQueryObservabilityService
  /**
   * The remote debugging reader (`/api/v1/debug/*`). Always built — its run index and overview
   * work off the execution store alone, and each telemetry sink it reads is independently
   * optional, so an unwired sink degrades to an empty page rather than to a missing surface.
   */
  runDebug?: RunDebugService
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
  /**
   * The deployment-declared environment-handler seeder, present only when the environments module
   * is wired. The runtime reads it to boot-backfill every existing workspace (and it is late-bound
   * into `WorkspaceService` for the on-create hook). A no-op when no seeds were declared.
   */
  environmentHandlerSeeder?: EnvironmentHandlerSeeder
  /**
   * The deployment-declared shared-stack seeder, present only when the shared-stacks module is
   * wired. Read by the runtime to boot-backfill every existing workspace, and late-bound into
   * `WorkspaceService` for the on-create hook. A no-op when no seeds were declared.
   */
  sharedStackSeeder?: SharedStackSeeder
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
  /** Present only when the merge track-record repository is wired (see CoreDependencies). */
  mergeTrackRecords?: MergeTrackRecordModule
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
  /**
   * Per-user in-app tutorial progress. Present only when its repository is wired; absent ⇒ the
   * controller reports 503 and the SPA keeps running on its browser-persisted copy alone, which
   * is the pre-existing behaviour rather than a broken feature.
   */
  tutorialProgress?: TutorialProgressModule
  /** Present only when the model-preset repository is wired (see CoreDependencies). */
  modelPresets?: ModelPresetsModule
  /** Present only when the consensus-group repository is wired (see CoreDependencies). */
  consensusGroups?: ConsensusGroupsModule
  /** Present only when the agent-prompt-override repository is wired (see CoreDependencies). */
  agentPrompts?: AgentPromptsModule
  workspaceAgentSettings?: WorkspaceAgentSettingsModule
  /** Present only when the service-fragment-defaults repository is wired (see CoreDependencies). */
  serviceFragmentDefaults?: ServiceFragmentDefaultsModule
  /** Present only when the prompt-fragment library is configured (see CoreDependencies). */
  fragmentLibrary?: FragmentLibraryModule
  /** Present only when the repo-sourced Claude Skills library is configured (see CoreDependencies). */
  skillLibrary?: SkillLibraryModule
  /** Present only when the foundational-services catalog is configured (see CoreDependencies). */
  foundationalServices?: FoundationalServiceModule
  /** Present only when the initiative repository is wired (see CoreDependencies). */
  initiatives?: InitiativesModule
  /** Present only when the recurring-pipeline repository is wired (see CoreDependencies). */
  recurring?: RecurringModule
  /** Present only when the tracker-settings repository is wired (see CoreDependencies). */
  tracker?: TrackerModule
  /**
   * Inbound tracker webhook handling (push-driven intake + ticket replies to a parked review).
   * Present only when the task projection + connections are wired; the shared receiver 503s
   * without it. See `backend/docs/adr/0032-tracker-webhook-intake.md`.
   */
  trackerWebhook?: TrackerWebhookModule
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
  modules.build('consensusGroups', () => createConsensusGroupsModule(dependencies))
  modules.build('agentPrompts', () => createAgentPromptsModule(dependencies))
  modules.build('workspaceAgentSettings', () => createWorkspaceAgentSettingsModule(dependencies))
  modules.build('serviceFragmentDefaults', () => createServiceFragmentDefaultsModule(dependencies))
}

export function createCore(injected: CoreDependencies): Core {
  const runtime = resolveCoreRuntime(injected)
  const {
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    pipelineRegistry,
    taskTypeRegistry,
    foundationalServiceRegistry,
    binaryGeneratorRegistry,
    binaryGenerators,
    foundationalBuiltins,
    initiativePresetRegistry,
    executionEventPublisher,
    caches,
    logger,
    operationalMetrics,
  } = runtime
  // `logger` is required on `CoreDependencies`, so `injected` already carries it; aliasing the
  // bag here keeps the rest of this function reading against one name and makes it explicit that
  // every service below is threaded the SAME resolved instance.
  const dependencies: CoreDependencies = injected
  // Built here rather than per request: it holds the per-process cap that keeps a
  // browser-supplied tour id from minting an unbounded number of metric series, and a cap with a
  // request-scoped lifetime would bound nothing.
  const tutorialTelemetry = new TutorialTelemetryService({ metrics: operationalMetrics, logger })
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
  // Late-bound: WorkspaceService.create reads the environment-handler seeder via
  // `getEnvironmentHandlerSeeder`; it is built AFTER the foundation (below, over the environments
  // module's connection service), so the workspace service resolves it at call time, not now.
  let environmentHandlerSeederRef: EnvironmentHandlerSeeder | undefined
  // Late-bound for the same reason, and resolved at the same call site: the shared-stack seeder is
  // built over the shared-stacks module, which lands after the foundation.
  let sharedStackSeederRef: SharedStackSeeder | undefined
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
      getEnvironmentHandlerSeeder: () => environmentHandlerSeederRef,
      getSharedStackSeeder: () => sharedStackSeederRef,
    })
  // All three registries are passed from the RESOLVED set, not spread in from `injected`: a facade
  // may leave any unset and `resolveCoreRuntime` supplies the default. That matters most for
  // `agentKindRegistry`, which decides whether a step's kind may be estimate-gated, and for
  // `gateRegistry`, which decides what a step's gate may be configured with — the run-start guard
  // (`RunAdmission`) reads the resolved instances, so a save reading `undefined` here could refuse
  // a shape the engine accepts, or accept one it refuses.
  const pipelineService = new PipelineService({
    ...dependencies,
    pipelineRegistry,
    agentKindRegistry,
    gateRegistry,
  })
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
  modules.build('tutorialProgress', () =>
    dependencies.tutorialProgressRepository
      ? {
          service: new TutorialProgressService({
            tutorialProgressRepository: dependencies.tutorialProgressRepository,
          }),
        }
      : undefined,
  )
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
  // The platform slice: observability, the provisioning event log, the infrastructure chain
  // (preflight → shared stacks → environments → the deployment-declared handler seeder) and the
  // content chain (documents → fragment library → skill library). Lifted into
  // `container/platform-modules.ts` for the per-function line budget; it registers in the SAME
  // order — which IS dependency order for the module registry — and returns only what the engine
  // below consumes.
  const platform = createPlatformModules({
    dependencies,
    modules,
    caches,
    executionEventPublisher,
    boardService,
    foundationalBuiltins,
  })
  const { environments, environmentHandlerSeeder, sharedStackSeeder, fragmentLibrary } = platform
  environmentHandlerSeederRef = environmentHandlerSeeder
  sharedStackSeederRef = sharedStackSeeder

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
  const mergeTrackRecords = modules.build('mergeTrackRecords', () =>
    createMergeTrackRecordModule(dependencies),
  )
  modules.build('sandbox', () => createSandboxModule(dependencies, agentKindRegistry))
  registerStandaloneModules(modules, dependencies)
  // The collaborators the engine needs BEFORE it is constructed (initiative + interview
  // services, the requirements / clarity / brainstorm / doc-interview / fork-chat / kaizen
  // review surfaces, and the task module), plus the late-bound initiative-loop poke. Lifted
  // into `container/engine-collaborators.ts` for the per-function line budget; the
  // registration order — which IS dependency order for the module registry — is preserved.
  const collaborators = createEngineCollaborators({
    dependencies,
    modules,
    initiativePresetRegistry,
    executionEventPublisher,
    notifications,
    fragmentLibrary,
    boardService,
    spend: spendService,
  })
  const { initiativeService, tasks, setInitiativeLoop } = collaborators

  // The engine itself. Its wiring literal — the largest in this root — lives beside it in
  // `container/execution-service.ts` for the per-function line budget; every field is threaded
  // exactly as it was, from the spine / modules / collaborators already resolved above.
  const executionService = buildExecutionService({
    dependencies,
    runtime,
    caches,
    boardService,
    spendService,
    settings,
    notifications,
    mergeTrackRecords,
    blueprintReconciler,
    platform,
    collaborators,
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
    mergeTrackRecords,
    notifications,
    initiativeService,
    setInitiativeLoop,
  })

  // The always-present spine, plus every optional module the registry assembled in ONE place
  // (unwired keys absent) — replacing the ~40 hand-written `...(x ? { x } : {})` return spreads.
  return {
    caches,
    logger,
    // Re-exposed on `Core` like `caches` and `logger`: the facade's sweepers and its
    // per-invocation flush need the SAME collector the services count into, and reaching it
    // off the container is what guarantees it is the same one.
    operationalMetrics,
    tutorialTelemetry,
    workspaceService,
    accountService,
    userService,
    boardService,
    pipelineService,
    executionService,
    spendService,
    agentKindRegistry,
    gateRegistry,
    judgeRegistry,
    pipelineRegistry,
    taskTypeRegistry,
    foundationalServiceRegistry,
    binaryGeneratorRegistry,
    binaryGenerators,
    initiativePresetRegistry,
    executionEventPublisher,
    ...modules.assemble(),
  }
}
