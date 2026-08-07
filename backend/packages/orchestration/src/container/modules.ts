/**
 * Optional-module FACTORY functions for the domain composition root.
 *
 * Extracted verbatim from `container.ts` (no behaviour change): each `createXModule` assembles
 * one optional feature's services when its prerequisites (repositories / cipher / provider) are
 * configured, else returns `undefined`. `createCore` declares each through the
 * {@link ModuleRegistry} and reads them back for the engine wiring. Kept in their own file so the
 * composition root (`container.ts`) holds the `CoreDependencies`/`Core` contract + the spine
 * assembly, and the ~30 leaf factories live next to each other here.
 *
 * The module INTERFACES and the `CoreDependencies`/`Core` types stay in `container.ts` (imported
 * back here type-only), so the value dependency is one-way `container.ts` → this file.
 */

import { UNATTRIBUTED_BLOCK_EDIT_AUTHORITY } from '@cat-factory/contracts'
import type {
  AppCaches,
  BugHuntAssessor,
  ExecutionEventPublisher,
  JudgeAssessor,
  TrackerIssueEvent,
} from '@cat-factory/kernel'
import type { SpendService } from '@cat-factory/spend'
import { type AgentKindRegistry } from '@cat-factory/agents'
import {
  BugIntakeService,
  BugHuntService,
  DocumentConnectionService,
  DocumentSourceOAuthService,
  DocumentContentResolverService,
  DocumentImportService,
  DocumentLinkService,
  DocumentPlannerService,
  LinkedDocumentRefreshService,
  EnvironmentConnectionService,
  EnvironmentTeardownService,
  GitHubInstallationService,
  GitHubService,
  GitHubSyncService,
  MapDocumentSourceRegistry,
  MapTaskSourceRegistry,
  PreflightService,
  ProvisioningLogRecorder,
  RepoProvisioningService,
  RunnerPoolConnectionService,
  SharedStackService,
  SlackConnectionService,
  SlackMemberMappingService,
  SlackSettingsService,
  TaskConnectionService,
  TaskImportService,
  TaskLinkService,
  TrackerWebhookService,
  WebhookService,
  defaultEnvironmentBackendRegistry,
  defaultRunnerBackendRegistry,
} from '@cat-factory/integrations'
import { ServiceMountService } from '../modules/services/ServiceMountService.js'
import { BoardService } from '../modules/board/BoardService.js'
import { ExecutionService } from '../modules/execution/ExecutionService.js'
import { BootstrapService } from '../modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from '../modules/envConfigRepair/EnvConfigRepairService.js'
import {
  buildEnvironmentProvisioningService,
  buildEnvironmentTestService,
  buildEnvironmentUserHandlerService,
} from './environmentsModule.factory.js'
import { resolveBlockRunContext } from './blockRunContext.js'
import { DocInterviewService } from '../modules/docInterview/DocInterviewService.js'
import { ForkChatService } from '../modules/execution/ForkChatService.js'
import { JudgeService } from '../modules/execution/JudgeService.js'
import { BugHuntAssessorService } from '../modules/bugHunt/BugHuntAssessorService.js'
import { TesterQualityReviewService } from '../modules/execution/TesterQualityReviewService.js'
import { KaizenService } from '../modules/kaizen/KaizenService.js'
import { NotificationService } from '../modules/notifications/NotificationService.js'
import { MergeTrackRecordService } from '../modules/merge/MergeTrackRecordService.js'
import { RiskPolicyService } from '../modules/merge/RiskPolicyService.js'
import { SandboxService } from '../modules/sandbox/SandboxService.js'
import { SandboxRunService } from '../modules/sandbox/SandboxRunService.js'
import { WorkspaceSettingsService } from '../modules/settings/WorkspaceSettingsService.js'
import { ReleaseHealthService } from '../modules/releaseHealth/ReleaseHealthService.js'
import { PackageRegistryService } from '../modules/packageRegistries/PackageRegistryService.js'
import { PreviewService } from '../modules/preview/PreviewService.js'
import { IncidentEnrichmentService } from '../modules/incidentEnrichment/IncidentEnrichmentService.js'
import { AgentPromptService } from '../modules/agentPrompts/AgentPromptService.js'
import { WorkspaceAgentSettingsService } from '../modules/agentSettings/WorkspaceAgentSettingsService.js'
import { TaskTypeSuppressionService } from '../modules/taskTypes/TaskTypeSuppressionService.js'
import { ModelPresetService } from '../modules/modelPresets/ModelPresetService.js'
import { inlineModelResolutionDeps } from './inline-model-deps.js'
import { ConsensusGroupService } from '../modules/consensusGroups/ConsensusGroupService.js'
import { ServiceFragmentDefaultsService } from '../modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import { RecurringPipelineService } from '../modules/recurring/RecurringPipelineService.js'
import { TrackerSettingsService } from '../modules/recurring/TrackerSettingsService.js'
// The bigger multi-collaborator module shapes still live beside their wiring in the composition
// root; the small single-/few-service ones come from `module-shapes.js`, so these factories carry
// no type-import back-edge onto `container.ts` for them.
import type {
  BootstrapModule,
  CoreDependencies,
  DocumentsModule,
  EnvironmentsModule,
  GitHubModule,
  RunnersModule,
  ServicesModule,
  TasksModule,
} from '../container.js'
import type {
  AgentPromptsModule,
  ClarityModule,
  IncidentEnrichmentModule,
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
  TaskTypeSuppressionModule,
  WorkspaceAgentSettingsModule,
  WorkspaceSettingsModule,
} from './module-shapes.js'

export function createServicesModule(deps: CoreDependencies): ServicesModule | undefined {
  const { serviceRepository, workspaceMountRepository } = deps
  if (!serviceRepository || !workspaceMountRepository) return undefined
  const service = new ServiceMountService({
    serviceRepository,
    workspaceMountRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the GitHub module when every dependency it needs is present;
 * otherwise return undefined so the feature stays cleanly opt-in.
 */
export function createGitHubModule(
  deps: CoreDependencies,
  caches: AppCaches,
  /**
   * Best-effort hook for a pull request merged OUTSIDE cat-factory (see
   * `makeExternalMergeObserver`). Passed in rather than resolved here because it spans the merge
   * track record + the notification inbox, neither of which this factory owns.
   */
  externalMergeObserver?: (workspaceId: string, repoId: string, prNumber: number) => Promise<void>,
): GitHubModule | undefined {
  const {
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    webhookVerifier,
  } = deps
  if (
    !githubClient ||
    !githubInstallationRepository ||
    !repoProjectionRepository ||
    !branchProjectionRepository ||
    !pullRequestProjectionRepository ||
    !issueProjectionRepository ||
    !commitProjectionRepository ||
    !checkRunProjectionRepository ||
    !webhookVerifier
  ) {
    return undefined
  }

  const installationService = new GitHubInstallationService({
    githubClient,
    githubInstallationRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    canCreateRepos: deps.canCreateRepos,
    workflowsGranted: deps.workflowsGranted,
  })
  const syncService = new GitHubSyncService({
    githubClient,
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    userRepoAccessRepository: deps.userRepoAccessRepository,
    clock: deps.clock,
    commitBackfillHorizonMs: deps.commitBackfillHorizonMs,
    // Drop a workspace's cached repo projection (slice 3) after any link/sync write.
    repoProjectionCache: caches.repoProjection,
    // Serve the add-service picker's PAT typeahead from a per-user cache (filter in memory)
    // instead of re-walking `/user/repos` on every keystroke.
    viewerReposCache: caches.viewerRepos,
  })
  const webhookService = new WebhookService({
    githubInstallationRepository,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    commitProjectionRepository,
    checkRunProjectionRepository,
    clock: deps.clock,
    repoProjectionCache: caches.repoProjection,
    // Drop a pushed branch's cached RepoFiles reads (slice 4) when a branch moves out-of-band.
    repoFilesCache: caches.repoFiles,
    // Repo-sourced skill freshness fan-out (slice 4): on a push, resync every skill source
    // linked to the repo. Both are facade-provided (the queue-backed enqueue only exists where
    // a runtime has a sync queue); unwired ⇒ the dispatch-time probe is the freshness backstop.
    skillSourceRepository: deps.skillSourceRepository,
    enqueueSkillResync: deps.enqueueSkillResync,
    // The same fan-out for repo-sourced foundational services: a pushed API contract reaches
    // the catalog in seconds rather than waiting out the autorefresh sweep.
    foundationalServiceSourceRepository: deps.foundationalServiceSourceRepository,
    enqueueFoundationalResync: deps.enqueueFoundationalResync,
    // Attribute a PR merged directly on the provider to its merge track record + nudge for the
    // reviewer-effort tag the merge card would have collected. Unwired ⇒ no-op.
    externalMergeObserver,
  })
  const service = new GitHubService({
    githubClient,
    repoProjectionRepository,
    branchProjectionRepository,
    pullRequestProjectionRepository,
    issueProjectionRepository,
    clock: deps.clock,
  })
  const provisioningService = deps.repoProvisioningClient
    ? new RepoProvisioningService({ client: deps.repoProvisioningClient })
    : undefined
  return {
    installationService,
    syncService,
    webhookService,
    service,
    webhookVerifier,
    provisioningService,
  }
}

/**
 * Assemble the document-source module when at least one provider + both
 * repositories are present. The model provider is optional: with it the planner
 * uses an LLM, and without it the deterministic heading parser — so the module
 * stays usable for import/link/spawn even when no LLM is configured.
 */
export function createDocumentsModule(
  deps: CoreDependencies,
  boardService: BoardService,
  caches: AppCaches,
): DocumentsModule | undefined {
  const { documentSourceProviders, documentConnectionStore, documentRepository } = deps
  if (
    !documentSourceProviders ||
    documentSourceProviders.length === 0 ||
    !documentConnectionStore ||
    !documentRepository
  ) {
    return undefined
  }

  const registry = new MapDocumentSourceRegistry(documentSourceProviders)
  // Built BEFORE the connection service, which renews through it: the dependency runs one way,
  // so neither needs a setter. A deployment with no account settings wired resolves no client,
  // which is reported as "OAuth is not offered here" rather than as a broken button.
  const oauthService = new DocumentSourceOAuthService({
    registry,
    resolveClient: async (workspaceId, source) => {
      // The registered app is per VENDOR (it lives in that vendor's developer console against a
      // redirect URL it holds), so the mapping from source to secret group is named here rather
      // than derived. A second OAuth-capable source adds its own group and one more arm; there
      // is deliberately no default, so an unmapped source is "not offered" and never a silent
      // reuse of another vendor's client.
      if (source !== 'figma' || !deps.accountSettings) return undefined
      const accountKey = (await deps.workspaceRepository.accountOf(workspaceId)) ?? workspaceId
      return (await deps.accountSettings.resolve(accountKey)).figmaOAuth
    },
    clock: deps.clock,
    logger: deps.logger,
  })
  const connectionService = new DocumentConnectionService({
    documentConnectionStore,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    oauthRenewer: oauthService,
    // Where persisting a renewed OAuth grant reports when it cannot land: a best-effort write, so
    // without this its failures are invisible and the renewal silently repeats every dispatch.
    logger: deps.logger,
    // Connecting or disconnecting a source invalidates every freshness verdict it authorised, and
    // a manual re-import invalidates that one document's: the TTL bounds how long a run dispatches
    // against an unnoticed edit, but only invalidation keeps a verdict from outliving the write
    // that made it wrong.
    versionCache: caches.linkedDocumentVersion,
  })
  const importService = new DocumentImportService({
    registry,
    documentRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
    versionCache: caches.linkedDocumentVersion,
  })
  const plannerService = new DocumentPlannerService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.documentPlannerModel,
  })
  const linkService = new DocumentLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    documentRepository,
  })
  const contentResolver = new DocumentContentResolverService({ registry, connectionService })
  // Wired unconditionally alongside the rest of the module: the refresh is not an opt-in capability
  // but the correct behaviour of reading a linked document, and a facade that could forget it would
  // silently go back to serving import-time copies (the failure this closes). Its own dependencies
  // are all already in hand — the version cache passes through where a profile disables it, which
  // costs a probe per dispatch rather than turning the refresh off.
  const linkedRefresher = new LinkedDocumentRefreshService({
    registry,
    connectionService,
    importService,
    versionCache: caches.linkedDocumentVersion,
    logger: deps.logger,
    // Every gap is per-DISPATCH and most are permanent while they last, so the log line answers
    // "what happened to this run" and only the counter answers "is this rising".
    metrics: deps.operationalMetrics,
  })
  return {
    connectionService,
    oauthService,
    importService,
    plannerService,
    linkService,
    contentResolver,
    linkedRefresher,
  }
}

/**
 * Assemble the task-source module when at least one provider + both repositories
 * are present; otherwise return undefined so the feature stays cleanly opt-in.
 * Unlike the documents module there is no planner — issues are linked for
 * context, not expanded into board structure.
 */
export function createTasksModule(
  deps: CoreDependencies,
  boardService: BoardService,
  spend: SpendService,
): TasksModule | undefined {
  const { taskSourceProviders, taskConnectionStore, taskSourceSettingsRepository, taskRepository } =
    deps
  if (
    !taskSourceProviders ||
    taskSourceProviders.length === 0 ||
    !taskConnectionStore ||
    !taskSourceSettingsRepository ||
    !taskRepository
  ) {
    return undefined
  }

  const registry = new MapTaskSourceRegistry(taskSourceProviders)
  const connectionService = new TaskConnectionService({
    taskConnectionStore,
    taskSourceSettingsRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    // Where the three surfaces that DEGRADE on an unopenable credential bag report (a re-connect
    // that could not carry the webhook secret over, the setup check, the webhook panel). Without
    // it those gaps are only visible in a panel nobody is looking at.
    logger: deps.logger,
    // GitHub Issues' availability is the installed GitHub App's presence; absent when
    // the GitHub integration isn't wired (the provider then isn't registered anyway).
    ...(deps.githubInstallationRepository
      ? { installations: deps.githubInstallationRepository }
      : {}),
    // Linear OAuth app credentials live in per-account deployment settings (sealed),
    // resolved dynamically — mirroring the Slack OAuth model. Absent ⇒ the "Connect with
    // Linear" flow isn't offered (manual API-key paste still works).
    ...(deps.accountSettings
      ? {
          resolveLinearOAuth: (accountKey: string) =>
            deps.accountSettings!.resolve(accountKey).then((s) => s.linearOAuth),
        }
      : {}),
  })
  const importService = new TaskImportService({
    registry,
    taskRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const linkService = new TaskLinkService({
    boardService,
    blockRepository: deps.blockRepository,
    taskRepository,
    importService,
  })
  // The recurring bug-intake step's read-and-claim helper — wired only when a schedule
  // repository is present (an intake fire resolves the schedule's `issueIntake` config by
  // block). Composes the just-built import/link services + the source registry, so it stays
  // provider-neutral and runtime-symmetric.
  const bugIntakeService = deps.pipelineScheduleRepository
    ? new BugIntakeService({
        pipelineScheduleRepository: deps.pipelineScheduleRepository,
        taskSourceRegistry: registry,
        taskConnectionStore,
        importService,
        linkService,
        taskRepository,
      })
    : undefined
  // The interactive bug hunt's read-and-rank helper. Unconditional (unlike the intake helper,
  // which needs a schedule repository): the board scan works with nothing but a connected
  // tracker, and the RANKING degrades inside the service when no model is wired — so a
  // model-less deployment still gets the board read rather than losing the whole surface.
  const bugHuntService = new BugHuntService({
    taskSourceRegistry: registry,
    taskConnectionStore,
    taskRepository,
    importService,
    linkService,
    // The ranking is a billable model call that no run start gates, so it answers to the SAME
    // workspace budget safeguard `RunAdmission` applies before a run — see the dependency's doc.
    isOverBudget: (workspaceId) => spend.isOverBudget(workspaceId),
    ...(() => {
      const assessor = createBugHuntAssessor(deps)
      return assessor ? { assessor } : {}
    })(),
  })
  return {
    registry,
    connectionService,
    importService,
    linkService,
    bugHuntService,
    ...(bugIntakeService ? { bugIntakeService } : {}),
  }
}

/**
 * The inline bug-hunt ranking model, built from the same dependencies the judge/reviewer
 * assessors ride — so a facade that wired a model gets a working hunt ranking with no
 * hunt-specific wiring (the judge-registry pattern). Absent provider ⇒ undefined, and the hunt
 * returns its candidates unranked with a stated reason.
 */
function createBugHuntAssessor(deps: CoreDependencies): BugHuntAssessor | undefined {
  if (deps.bugHuntAssessor) return deps.bugHuntAssessor
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new BugHuntAssessorService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    ...(deps.logger ? { logger: deps.logger } : {}),
  })
}

/**
 * Assemble the environment integration when its provider, both repositories and
 * the secret cipher are present; otherwise return undefined so the feature stays
 * cleanly opt-in (the deterministic deployer and env discovery in the engine are
 * gated on the provisioning service being wired).
 */
export function createEnvironmentsModule(
  deps: CoreDependencies,
  provisioningLog: ProvisioningLogRecorder | undefined,
  eventPublisher: ExecutionEventPublisher | undefined,
  sharedStackService: SharedStackService | undefined,
  preflightService: PreflightService | undefined,
): EnvironmentsModule | undefined {
  const { environmentConnectionRepository, environmentRegistryRepository, secretCipher } = deps
  if (!environmentConnectionRepository || !environmentRegistryRepository || !secretCipher) {
    return undefined
  }

  // Durable async config repair is wired when both the dispatcher (the side-effecting
  // container plumbing) and the kind-scoped job repository are present. The repair service
  // and the connection service are mutually dependent: the connection service's
  // `dispatchConfigRepair` seam STARTS a repair run (→ repairService), and the repair run's
  // success path RE-VALIDATES via the connection service. We break the cycle by capturing
  // `repairService` in a closure that is only invoked at request time (after assignment).
  const canRepair = !!(deps.envConfigRepairer && deps.envConfigRepairJobRepository)
  let repairService: EnvConfigRepairService | undefined

  const connectionService = new EnvironmentConnectionService({
    environmentConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    secretCipher,
    ...(deps.secretDelegate ? { secretDelegate: deps.secretDelegate } : {}),
    clock: deps.clock,
    environmentBackendRegistry:
      deps.environmentBackendRegistry ?? defaultEnvironmentBackendRegistry(),
    ...(deps.customManifestTypeRepository
      ? { customManifestTypeRepository: deps.customManifestTypeRepository }
      : {}),
    ...(deps.customManifestTypeRegistry
      ? { customManifestTypeRegistry: deps.customManifestTypeRegistry }
      : {}),
    ...(deps.environmentCustomTlsSupported !== undefined
      ? { customTlsSupported: deps.environmentCustomTlsSupported }
      : {}),
    ...(deps.environmentProvider ? { environmentProvider: deps.environmentProvider } : {}),
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    ...(deps.detectionConventions ? { detectionConventions: deps.detectionConventions } : {}),
    ...(canRepair
      ? {
          dispatchConfigRepair: (input) =>
            repairService!
              .start(input.workspaceId, {
                owner: input.owner,
                repo: input.repo,
                gitRef: input.gitRef,
                issues: input.issues,
                ...(input.inputs ? { inputs: input.inputs } : {}),
                ...(input.promptOverride ? { promptOverride: input.promptOverride } : {}),
                ...(input.manifestPath ? { manifestPath: input.manifestPath } : {}),
              })
              .then((job) => ({ jobId: job.id })),
        }
      : {}),
    ...(provisioningLog ? { provisioningLog } : {}),
  })

  if (canRepair) {
    repairService = new EnvConfigRepairService({
      envConfigRepairJobRepository: deps.envConfigRepairJobRepository!,
      workspaceRepository: deps.workspaceRepository,
      idGenerator: deps.idGenerator,
      clock: deps.clock,
      repairer: deps.envConfigRepairer!,
      ...(deps.envConfigRepairRunner ? { runner: deps.envConfigRepairRunner } : {}),
      ...(eventPublisher ? { eventPublisher } : {}),
      revalidate: (input) => connectionService.revalidate(input),
    })
  }
  // The per-USER override store is wired ONLY when its repository is present — which, by
  // design, ONLY the local facade does (so per-user overrides + the per-user controller are
  // local-mode-only, with no runtime branch in shared code). Its `resolveOverrides` is the
  // `resolveUserHandlerOverrides` seam the provisioning service layers over the workspace
  // handlers for the run initiator.
  const userHandlerService = buildEnvironmentUserHandlerService(deps, secretCipher)
  // Built BEFORE the provisioning service so it can be injected as `environmentTeardown` there:
  // a deployer re-run that supersedes a prior env with a DIFFERENT provider identity tears the old
  // infra down through this service (best-effort; the TTL reaper is the backstop).
  const teardownService = new EnvironmentTeardownService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    // Wired in lockstep with the provisioning service's own delegate below: teardown opens the
    // very `provisionFieldsCipher` that provisioning sealed, so a node holding one and not the
    // other could stand an environment up and never reclaim it.
    ...(deps.secretDelegate ? { secretDelegate: deps.secretDelegate } : {}),
    clock: deps.clock,
    ...(provisioningLog ? { provisioningLog } : {}),
    logger: deps.logger,
  })
  const provisioningService = buildEnvironmentProvisioningService({
    deps,
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    teardownService,
    userHandlerService,
    sharedStackService,
    preflightService,
    provisioningLog,
  })
  // The ephemeral-environment self-test: needs its own run store + a git provider (to
  // create/delete the throwaway branch). Absent either ⇒ no self-test (the controller 503s).
  const environmentTest = buildEnvironmentTestService({
    deps,
    provisioningService,
    teardownService,
    environmentRegistryRepository,
    eventPublisher,
  })

  return {
    connectionService,
    provisioningService,
    teardownService,
    ...(userHandlerService ? { userHandlerService } : {}),
    ...(repairService ? { envConfigRepair: { service: repairService } } : {}),
    ...(environmentTest ? { environmentTest } : {}),
  }
}

/**
 * Assemble the self-hosted runner-pool module when its connection repository and
 * the secret cipher are present; otherwise return undefined so the feature stays
 * cleanly opt-in. Per-tenant scheduler-API secrets are encrypted via the cipher.
 */
export function createRunnersModule(deps: CoreDependencies): RunnersModule | undefined {
  const { runnerPoolConnectionRepository, runnerSecretCipher } = deps
  if (!runnerPoolConnectionRepository || !runnerSecretCipher) return undefined

  const connectionService = new RunnerPoolConnectionService({
    runnerPoolConnectionRepository,
    workspaceRepository: deps.workspaceRepository,
    secretCipher: runnerSecretCipher,
    clock: deps.clock,
    logger: deps.logger,
    runnerBackendRegistry: deps.runnerBackendRegistry ?? defaultRunnerBackendRegistry(),
    ...(deps.runnerPoolProvider ? { runnerPoolProvider: deps.runnerPoolProvider } : {}),
    ...(deps.runnerUrlSafetyPolicy ? { urlPolicy: deps.runnerUrlSafetyPolicy } : {}),
    ...(deps.runnerCustomTlsSupported !== undefined
      ? { customTlsSupported: deps.runnerCustomTlsSupported }
      : {}),
  })
  return { connectionService }
}

/**
 * Assemble the repo-bootstrap module when both its repositories are present (the
 * worker wires them unconditionally). The `repoBootstrapper` is passed through
 * but optional: the service exposes CRUD regardless and only gates the run path
 * on its presence.
 */
export function createBootstrapModule(
  deps: CoreDependencies,
  eventPublisher: ExecutionEventPublisher,
  onBootstrapSucceeded?: (workspaceId: string, blockId: string) => Promise<void>,
): BootstrapModule | undefined {
  const { referenceArchitectureRepository, bootstrapJobRepository } = deps
  if (!referenceArchitectureRepository || !bootstrapJobRepository) return undefined

  const service = new BootstrapService({
    referenceArchitectureRepository,
    bootstrapJobRepository,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    serviceRepository: deps.serviceRepository,
    workspaceMountRepository: deps.workspaceMountRepository,
    serviceFragmentDefaultsRepository: deps.serviceFragmentDefaultsRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    repoBootstrapper: deps.repoBootstrapper,
    bootstrapRunner: deps.bootstrapRunner,
    eventPublisher,
    ...(onBootstrapSucceeded ? { onBootstrapSucceeded } : {}),
  })
  return { service }
}

/**
 * Assemble the requirements-review module when its repository is present (the
 * worker wires it unconditionally). The model provider/ref are optional within
 * the module — reads work without them and the run paths surface a clear error —
 * and the document/task repositories are reused, when wired, to fold linked PRDs
 * and tracker issues into the reviewed requirements.
 */
/**
 * Build the inline reviewer for the test quality-control companion. It resolves its model
 * exactly like the requirements reviewer (block pin → workspace per-kind default → routing
 * default). Returns `undefined` when no model provider is configured, so the Tester gate's QC
 * step is a pass-through in unconfigured facades / tests.
 */
export function createTesterQualityReviewer(
  deps: CoreDependencies,
): TesterQualityReviewService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new TesterQualityReviewService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

/**
 * Build the interactive document-interview service (WS5). Self-contained (owns its session
 * store + the inline LLM); resolves its model exactly like the requirements reviewer (block
 * pin → workspace per-kind default → routing default). Returns `undefined` when no session
 * store is wired, so the `doc-interviewer` step passes through in unconfigured facades / tests.
 * The LLM is optional within the service (the `enabled` getter is false without a model), so a
 * store-but-no-model deployment still short-circuits the interviewer.
 */
export function createDocInterviewService(deps: CoreDependencies): DocInterviewService | undefined {
  const { docInterviewRepository } = deps
  if (!docInterviewRepository) return undefined
  return new DocInterviewService({
    docInterviewRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

/**
 * Build the inline grounded-chat responder for the implementation-fork decision phase. Resolves
 * its model exactly like the requirements reviewer / doc interviewer (block pin → workspace
 * per-kind default → routing default). Returns `undefined` when no model provider is configured,
 * so the fork chat degrades to a canned "chat unavailable" reply in unconfigured facades / tests
 * while pick / custom keep working. Stateless — the chat rides the coder step, no session store.
 */
/**
 * The default {@link JudgeAssessor}: the inline LLM verdict producer behind every judge step.
 * Built from the SAME model-provider dependencies the inline reviewers use, which is why judges
 * need no per-facade wiring at all — a facade that can run a requirements review can run a
 * judge. Returns undefined when no provider is wired, and a facade/harness may inject its own
 * `judgeAssessor` (conformance does, for a deterministic verdict); either way an
 * absent/disabled assessor makes every judge step a pass-through.
 */
export function createJudgeAssessor(deps: CoreDependencies): JudgeAssessor | undefined {
  if (deps.judgeAssessor) return deps.judgeAssessor
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new JudgeService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

export function createForkChatService(deps: CoreDependencies): ForkChatService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new ForkChatService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

// The inline iterative-review modules (requirements / clarity / brainstorm) live in
// `review-modules.ts` — one cohesive group, extracted when this file hit its size budget. Re-exported
// here so the composition root keeps one import site for every module factory.
export {
  createBrainstormModule,
  createClarityModule,
  createRequirementsModule,
} from './review-modules.js'

/**
 * Assemble the Kaizen module when its repositories are wired (both runtime facades wire them
 * unconditionally). The grader resolves its model for the `kaizen` kind the same way the
 * requirements reviewer does — block pin > workspace per-kind default > routing default —
 * so operators configure it in Model Configuration alongside every other agent. Needs the
 * telemetry repos (LLM-call metrics + agent-context snapshots) to read what each step was
 * given; absent → the module isn't built and no grading is scheduled.
 */
export function createKaizenModule(deps: CoreDependencies): KaizenModule | undefined {
  const { kaizenGradingRepository, kaizenVerifiedComboRepository } = deps
  if (!kaizenGradingRepository || !kaizenVerifiedComboRepository) return undefined
  if (!deps.llmCallMetricRepository || !deps.agentContextObservability) return undefined

  const service = new KaizenService({
    kaizenGradingRepository,
    kaizenVerifiedComboRepository,
    blockRepository: deps.blockRepository,
    llmCallMetricRepository: deps.llmCallMetricRepository,
    agentContextObservability: deps.agentContextObservability,
    workspaceSettingsRepository: deps.workspaceSettingsRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    events: deps.executionEventPublisher,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The routing default, the block-model resolver, the local-mode inline predicate, and the
    // preset's per-kind default model + route order — wired as ONE slice (see the factory).
    ...inlineModelResolutionDeps(deps),
  })
  return { service }
}

/**
 * Assemble the notifications module when its repository is present (the worker
 * wires it unconditionally). The delivery channel is optional within the module —
 * without it the rows still persist (the inbox + snapshot work) but nothing is
 * pushed; the worker wires the in-app channel, and email/Slack compose in later.
 */
export function createNotificationsModule(deps: CoreDependencies): NotificationsModule | undefined {
  const { notificationRepository } = deps
  if (!notificationRepository) return undefined
  const service = new NotificationService({
    notificationRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    channel: deps.notificationChannel,
  })
  return { service }
}

/**
 * Assemble the Slack integration module when its three repositories and the
 * secret cipher are present. Powers the management API (connect/settings/member
 * map); the actual Slack delivery is a `notificationChannel` composed in by the
 * facade. OAuth is optional — manual-token onboarding works without it.
 */
export function createSlackModule(deps: CoreDependencies): SlackModule | undefined {
  const {
    slackConnectionRepository,
    slackSettingsRepository,
    slackMemberMappingRepository,
    slackSecretCipher,
  } = deps
  if (
    !slackConnectionRepository ||
    !slackSettingsRepository ||
    !slackMemberMappingRepository ||
    !slackSecretCipher
  ) {
    return undefined
  }
  return {
    connectionService: new SlackConnectionService({
      slackConnectionRepository,
      workspaceRepository: deps.workspaceRepository,
      secretCipher: slackSecretCipher,
      clock: deps.clock,
      resolveOAuth: deps.accountSettings
        ? (accountKey) => deps.accountSettings!.resolve(accountKey).then((s) => s.slackOAuth)
        : undefined,
    }),
    settingsService: new SlackSettingsService({
      slackSettingsRepository,
      workspaceRepository: deps.workspaceRepository,
      clock: deps.clock,
    }),
    memberMappingService: new SlackMemberMappingService({
      slackMemberMappingRepository,
      workspaceRepository: deps.workspaceRepository,
      clock: deps.clock,
    }),
  }
}

/** Assemble the merge-preset module when its repository is present. */
export function createRiskPoliciesModule(
  deps: CoreDependencies,
  caches: AppCaches,
): RiskPoliciesModule | undefined {
  const { riskPolicyRepository } = deps
  if (!riskPolicyRepository) return undefined
  const service = new RiskPolicyService({
    riskPolicyRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    // Invalidate the read-through slice the engine's `resolveRiskPolicy` uses on every write.
    riskPolicyCache: caches.riskPolicy,
  })
  return { service }
}

/**
 * Assemble the merge track-record module when its repository is present: the per-class change
 * classification the merge policy's per-class rules key off, plus the persisted evidence behind
 * every merge decision. Absent ⇒ classification yields `unknown`, no per-class rule matches, and
 * the merge path behaves exactly as it did before the feature existed.
 */
export function createMergeTrackRecordModule(
  deps: CoreDependencies,
): MergeTrackRecordModule | undefined {
  const { mergeTrackRecordRepository } = deps
  if (!mergeTrackRecordRepository) return undefined
  return {
    service: new MergeTrackRecordService({
      mergeTrackRecordRepository,
      workspaceRepository: deps.workspaceRepository,
      clock: deps.clock,
      // Reads the PR's changed-file list through the same run-repo seam the engine's pre/post-ops
      // use — provider-neutral, so classification works identically on a GitLab deployment.
      resolveRunRepoContext: deps.resolveRunRepoContext,
      // The whole feature swallows its own failures, so without this a dead side channel is
      // indistinguishable from a healthy one.
      logger: deps.logger,
    }),
  }
}

/**
 * Assemble the shared-stacks module when its repository is present. The `composeRuntime` is
 * optional — wired only on the local facade, so CRUD works everywhere but the lifecycle
 * (ensureUp/teardown) refuses without a host daemon (the documented compose runtime-binding
 * exception). Persistence is fully runtime-symmetric.
 */
export function createSharedStacksModule(
  deps: CoreDependencies,
  preflightService: PreflightService | undefined,
): SharedStacksModule | undefined {
  const { sharedStackRepository } = deps
  if (!sharedStackRepository) return undefined
  const service = new SharedStackService({
    sharedStackRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    ...(deps.composeRuntime ? { composeRuntime: deps.composeRuntime } : {}),
    ...(deps.sharedStackCloneToken ? { cloneToken: deps.sharedStackCloneToken } : {}),
    // Enables the checkout-free repo autodetection (`detect`); wired from the same coords-bound
    // RepoFiles resolver the environment detector uses, so both facades get it for free.
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    // Same deployment-level detection-convention extensions the environment detector honours, so
    // shared-stack `detect` recognises the org's house compose layout too.
    ...(deps.detectionConventions ? { detectionConventions: deps.detectionConventions } : {}),
    // Re-run a stack's declared machine-prerequisite checks at bring-up start. Present only where
    // the host-probe seam is wired (the local facade — same runtime binding as `composeRuntime`).
    ...(preflightService ? { runPreflights: (refs) => preflightService.run(refs) } : {}),
    logger: deps.logger,
  })
  return { service }
}

/**
 * Assemble the preflight module when the host-probe seam is present — wired ONLY on the local
 * facade (a host Docker daemon), the documented compose runtime-binding exception. Absent elsewhere
 * ⇒ the preflight API 503s and a stack recipe that declares `prerequisites` fails loudly at
 * provision (rather than silently skipping a declared machine-prerequisite gate).
 */
export function createPreflightModule(deps: CoreDependencies): PreflightsModule | undefined {
  if (!deps.preflightHostProbes) return undefined
  return { service: new PreflightService({ hostProbes: deps.preflightHostProbes }) }
}

/**
 * Assemble the Sandbox module when its five repositories are present (both runtime
 * facades wire them together). Reuses the requirements reviewer's inline model config —
 * the per-scope provider resolver, the routing default ref, and the block-model resolver
 * — so a Sandbox cell (and the judge) resolves its catalog id exactly like a pipeline step.
 */
export function createSandboxModule(
  deps: CoreDependencies,
  agentKindRegistry: AgentKindRegistry,
): SandboxModule | undefined {
  const {
    sandboxPromptVersionRepository,
    sandboxFixtureRepository,
    sandboxExperimentRepository,
    sandboxRunRepository,
    sandboxGradeRepository,
  } = deps
  if (
    !sandboxPromptVersionRepository ||
    !sandboxFixtureRepository ||
    !sandboxExperimentRepository ||
    !sandboxRunRepository ||
    !sandboxGradeRepository
  ) {
    return undefined
  }
  const repositories = {
    sandboxPromptVersionRepository,
    sandboxFixtureRepository,
    sandboxExperimentRepository,
    sandboxRunRepository,
    sandboxGradeRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    agentKindRegistry,
    // Optional: lets the prompt browser offer the workspace's OWN prompts (edited in the pipeline
    // builder) beside the shipped baselines, so a candidate can be measured against what is
    // actually running. Absent ⇒ baselines + stored candidates only.
    ...(deps.agentPromptRepository ? { agentPromptRepository: deps.agentPromptRepository } : {}),
  }
  const defaultModelRef = deps.requirementReviewModel ?? deps.documentPlannerModel
  const service = new SandboxService({ ...repositories, defaultModelRef })
  const runService = new SandboxRunService({
    ...repositories,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    resolveModelId: deps.requirementReviewResolveModel,
    defaultModelRef,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
  })
  return { service, runService }
}

/** Assemble the workspace-settings module when its repository is present. */
export function createWorkspaceSettingsModule(
  deps: CoreDependencies,
  workspaceSettingsCache: AppCaches['workspaceSettings'],
): WorkspaceSettingsModule | undefined {
  const { workspaceSettingsRepository } = deps
  if (!workspaceSettingsRepository) return undefined
  const service = new WorkspaceSettingsService({
    workspaceSettingsRepository,
    workspaceRepository: deps.workspaceRepository,
    workspaceSettingsCache,
  })
  return { service }
}

/** Assemble the release-health (observability) module when its repos + cipher are present. */
export function createReleaseHealthModule(deps: CoreDependencies): ReleaseHealthModule | undefined {
  const {
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
  } = deps
  if (
    !observabilityConnectionRepository ||
    !releaseHealthConfigRepository ||
    !observabilitySecretCipher
  ) {
    return undefined
  }
  const service = new ReleaseHealthService({
    observabilityConnectionRepository,
    releaseHealthConfigRepository,
    observabilitySecretCipher,
    workspaceRepository: deps.workspaceRepository,
    blockRepository: deps.blockRepository,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the package-registries module when its repo + cipher are present. */
export function createPackageRegistriesModule(
  deps: CoreDependencies,
): PackageRegistriesModule | undefined {
  const { packageRegistryConnectionRepository, packageRegistrySecretCipher } = deps
  if (!packageRegistryConnectionRepository || !packageRegistrySecretCipher) {
    return undefined
  }
  const service = new PackageRegistryService({
    packageRegistryConnectionRepository,
    packageRegistrySecretCipher,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
    idGenerator: deps.idGenerator,
  })
  return { service }
}

/**
 * Assemble the browsable-frontend-preview module when its per-runtime transport + the facade's
 * job builder + the env registry are all wired (local/node with a host-port-publish runtime).
 * Absent on the Worker (no preview transport) ⇒ the controller 503s there.
 */
export function createPreviewModule(deps: CoreDependencies): PreviewModule | undefined {
  const { previewTransport, buildPreviewJob, environmentRegistryRepository } = deps
  if (!previewTransport || !buildPreviewJob || !environmentRegistryRepository) return undefined
  const service = new PreviewService({
    previewTransport,
    buildPreviewJob,
    environmentRegistryRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the incident-enrichment settings module when its repo + cipher are present. */
export function createIncidentEnrichmentModule(
  deps: CoreDependencies,
): IncidentEnrichmentModule | undefined {
  const { incidentEnrichmentConnectionRepository, incidentEnrichmentSecretCipher } = deps
  if (!incidentEnrichmentConnectionRepository || !incidentEnrichmentSecretCipher) return undefined
  const service = new IncidentEnrichmentService({
    incidentEnrichmentConnectionRepository,
    incidentEnrichmentSecretCipher,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the model-presets module when its repository is present. */
export function createModelPresetsModule(deps: CoreDependencies): ModelPresetsModule | undefined {
  const { modelPresetRepository } = deps
  if (!modelPresetRepository) return undefined
  const service = new ModelPresetService({
    modelPresetRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    ...(deps.defaultModelPresetId ? { defaultPresetId: deps.defaultModelPresetId } : {}),
    // Every write drops the workspace group, so a re-pointed model or a re-ordered route list is
    // visible on the very next dispatch rather than after the TTL.
    ...(deps.caches ? { modelPresetCache: deps.caches.modelPreset } : {}),
  })
  return { service }
}

/**
 * Assemble the consensus-group library when its repository is present. Absent ⇒ the controller
 * 503s and a consensus step runs the inline participants authored on it, exactly as before the
 * library existed.
 */
export function createConsensusGroupsModule(
  deps: CoreDependencies,
): ConsensusGroupsModule | undefined {
  const { consensusGroupRepository } = deps
  if (!consensusGroupRepository) return undefined
  const service = new ConsensusGroupService({
    consensusGroupRepository,
    workspaceRepository: deps.workspaceRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the agent-prompt-override module when its repository is present. Absent ⇒ the
 * controller 503s and every agent kind runs the prompt it ships with.
 */
export function createAgentPromptsModule(deps: CoreDependencies): AgentPromptsModule | undefined {
  const { agentPromptRepository } = deps
  if (!agentPromptRepository) return undefined
  const service = new AgentPromptService({
    agentPromptRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the per-agent-kind generation-settings module when its repository is present.
 * Absent ⇒ the controller 503s and every kind runs on the deployment routing ceiling.
 */
export function createWorkspaceAgentSettingsModule(
  deps: CoreDependencies,
): WorkspaceAgentSettingsModule | undefined {
  const { workspaceAgentSettingsRepository } = deps
  if (!workspaceAgentSettingsRepository) return undefined
  const service = new WorkspaceAgentSettingsService({
    workspaceAgentSettingsRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the per-workspace operation-suppression module when its repository is present.
 * Absent ⇒ the controller 503s and every board offers every registered operation.
 */
export function createTaskTypeSuppressionModule(
  deps: CoreDependencies,
): TaskTypeSuppressionModule | undefined {
  const { taskTypeSuppressionRepository } = deps
  if (!taskTypeSuppressionRepository) return undefined
  const service = new TaskTypeSuppressionService({
    taskTypeSuppressionRepository,
    workspaceRepository: deps.workspaceRepository,
    taskTypeRegistry: deps.taskTypeRegistry,
    clock: deps.clock,
  })
  return { service }
}

/** Assemble the service-fragment-defaults module when its repository is present. */
export function createServiceFragmentDefaultsModule(
  deps: CoreDependencies,
): ServiceFragmentDefaultsModule | undefined {
  const { serviceFragmentDefaultsRepository } = deps
  if (!serviceFragmentDefaultsRepository) return undefined
  const service = new ServiceFragmentDefaultsService({
    serviceFragmentDefaultsRepository,
    workspaceRepository: deps.workspaceRepository,
  })
  return { service }
}

/** Assemble the tracker-settings module when its repository is present. */
export function createTrackerModule(deps: CoreDependencies): TrackerModule | undefined {
  const { trackerSettingsRepository } = deps
  if (!trackerSettingsRepository) return undefined
  const service = new TrackerSettingsService({
    trackerSettingsRepository,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  return { service }
}

/**
 * Assemble the TRACKER WEBHOOK module: what a verified, parsed inbound tracker delivery does.
 *
 * Built after the engine because both of its branches drive engine-owned surfaces — the intake
 * branch fires a recurring schedule, the reply branch drives the parked requirements review
 * through the SAME `executionService.requirementsReview` actions the SPA controller calls. Binding
 * those here (rather than letting `@cat-factory/integrations` reach for them) is what keeps the
 * layering right AND makes "no parallel mutation path into the engine" true by construction.
 *
 * Every collaborator is optional, and the service degrades branch-by-branch: no recurring module ⇒
 * pushed issue events are ignored (the polling schedule still covers intake); no requirements
 * module or no ingest marker store ⇒ ticket replies are ignored. So a facade that wires only some
 * of this behaves exactly as it did before, rather than half-working.
 */
export function createTrackerWebhookModule(
  deps: CoreDependencies,
  input: {
    tasks: TasksModule | undefined
    recurring: RecurringModule | undefined
    requirements: RequirementsModule | undefined
    clarity: ClarityModule | undefined
    executionService: ExecutionService
  },
): TrackerWebhookModule | undefined {
  const { taskRepository, taskConnectionStore } = deps
  if (!taskRepository || !taskConnectionStore || !input.tasks) return undefined
  const requirementsService = input.requirements?.service
  const clarityService = input.clarity?.service
  const recurring = input.recurring
  const service = new TrackerWebhookService({
    taskRepository,
    taskConnectionStore,
    ...(recurring
      ? {
          triggerIntake: (workspaceId: string, event: TrackerIssueEvent) =>
            recurring.service.triggerForIssueEvent(workspaceId, event),
        }
      : {}),
    reviewGateways: {
      // Both subjects are bound the same way, and the split inside each is the point: the ITEM
      // mutations go through the review service, while the run-DRIVING half goes through the
      // engine's window actions, so the park's CAS/approval-id arbitration and the task's preset
      // knobs apply exactly as they do for the SPA and the public decision surface.
      ...(requirementsService
        ? {
            requirements: {
              getForBlock: (ws, blockId) => requirementsService.getForBlock(ws, blockId),
              replyToItem: (ws, reviewId, itemId, reply) =>
                requirementsService.replyToItem(ws, reviewId, itemId, reply),
              setItemStatus: (ws, reviewId, itemId, status) =>
                requirementsService.setItemStatus(ws, reviewId, itemId, status),
              incorporate: (ws, blockId, feedback) =>
                input.executionService.requirementsReview.incorporate(ws, blockId, feedback),
              proceed: (ws, blockId) =>
                input.executionService.requirementsReview.proceed(ws, blockId),
              resolveExceeded: (ws, blockId, choice) =>
                input.executionService.requirementsReview.resolveExceeded(ws, blockId, choice),
            },
          }
        : {}),
      ...(clarityService
        ? {
            clarity: {
              getForBlock: (ws, blockId) => clarityService.getForBlock(ws, blockId),
              replyToItem: (ws, reviewId, itemId, reply) =>
                clarityService.replyToItem(ws, reviewId, itemId, reply),
              setItemStatus: (ws, reviewId, itemId, status) =>
                clarityService.setItemStatus(ws, reviewId, itemId, status),
              incorporate: (ws, blockId, feedback) =>
                input.executionService.clarityReview.incorporate(ws, blockId, feedback),
              proceed: (ws, blockId) => input.executionService.clarityReview.proceed(ws, blockId),
              resolveExceeded: (ws, blockId, choice) =>
                input.executionService.clarityReview.resolveExceeded(ws, blockId, choice),
            },
          }
        : {}),
    },
    ...(deps.trackerCommentIngestRepository
      ? { commentIngestRepository: deps.trackerCommentIngestRepository }
      : {}),
    ...(deps.issueWritebackProvider ? { issueWriteback: deps.issueWritebackProvider } : {}),
    resolveRunId: (ws, blockId) =>
      deps.executionRepository.getByBlock(ws, blockId).then((run) => run?.id ?? null),
    clock: deps.clock,
    logger: deps.logger,
  })
  return { service }
}

/**
 * Assemble the recurring-pipeline module when its repository is present. Built
 * after the execution engine since each fire starts a pipeline through it.
 */
export function createRecurringModule(
  deps: CoreDependencies,
  executionService: ExecutionService,
  executionEventPublisher: ExecutionEventPublisher,
  taskConnectionService?: TaskConnectionService,
  tasks?: Pick<TasksModule, 'importService' | 'linkService'>,
): RecurringModule | undefined {
  const { pipelineScheduleRepository } = deps
  if (!pipelineScheduleRepository) return undefined
  const service = new RecurringPipelineService({
    pipelineScheduleRepository,
    workspaceRepository: deps.workspaceRepository,
    pipelineRepository: deps.pipelineRepository,
    blockRepository: deps.blockRepository,
    executionRepository: deps.executionRepository,
    executionService,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    serviceRepository: deps.serviceRepository,
    workspaceMountRepository: deps.workspaceMountRepository,
    // Validates a `bug-intake` pipeline's schedule carries an `issueIntake` config whose source
    // is a connected task source. Absent (no task sources wired) → the presence check still runs.
    taskConnectionService,
    // Pushes a `block-added` board event when the reused block is created, so it appears live.
    executionEventPublisher,
    // Gives `triggerForIssueEvent`'s per-schedule isolation somewhere to report to; without it a
    // webhook-fired schedule that consistently fails leaves no trace at all.
    logger: deps.logger,
    // PER-TICKET dispatch. Bound to the SAME import + create-task services a human's "create task
    // from issue" goes through, so a webhook-dispatched ticket and a hand-adopted one produce
    // byte-for-byte the same block, link and seeded title/description.
    ...(tasks
      ? {
          adoptIssueAsTask: async (input) => {
            // The import is an idempotent projection upsert, and it hands back the row — whose
            // `linkedBlockId` is exactly "has this ticket already been dispatched". An issue
            // carries ONE link, so that field IS the idempotency a redelivery needs; no claim
            // table buys anything the link does not already guarantee.
            //
            // Read off the returned row rather than by catching `createTaskFromIssue`'s conflict:
            // its refusal is prose, and matching prose would silently start double-dispatching
            // the day someone rewords it. A genuine RACE (two deliveries interleaving between
            // this read and the create) still lands on that conflict and propagates, which is
            // correct — the caller's per-schedule isolation logs it and the ticket is already
            // dispatched by the winner.
            const issue = await tasks.importService.import(
              input.workspaceId,
              input.source,
              input.externalId,
            )
            if (issue.linkedBlockId) return null

            const { block } = await tasks.linkService.createTaskFromIssue({
              workspaceId: input.workspaceId,
              containerId: input.containerId,
              source: input.source,
              externalId: input.externalId,
              // A ticket arriving on a schedule or a webhook is filed by nobody: there is no
              // session, so no workspace tier, and inventing one would scope the whole
              // integration to a role no operator granted (ADR 0037).
              editor: UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
              createdBy: null,
              shape: { pipelineId: input.pipelineId },
            })
            return { blockId: block.id }
          },
        }
      : {}),
  })
  return { service }
}
