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

import type { AppCaches, Block, ExecutionEventPublisher } from '@cat-factory/kernel'
import { getFragment } from '@cat-factory/prompt-fragments'
import { type AgentKindRegistry } from '@cat-factory/agents'
import {
  BugIntakeService,
  DocumentConnectionService,
  DocumentContentResolverService,
  DocumentImportService,
  DocumentLinkService,
  DocumentPlannerService,
  EnvironmentConnectionService,
  EnvironmentProvisioningService,
  EnvironmentTeardownService,
  EnvironmentUserHandlerService,
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
  WebhookService,
  defaultEnvironmentBackendRegistry,
  defaultRunnerBackendRegistry,
} from '@cat-factory/integrations'
import { ServiceMountService } from '../modules/services/ServiceMountService.js'
import { BoardService } from '../modules/board/BoardService.js'
import { ExecutionService } from '../modules/execution/ExecutionService.js'
import { BootstrapService } from '../modules/bootstrap/BootstrapService.js'
import { EnvConfigRepairService } from '../modules/envConfigRepair/EnvConfigRepairService.js'
import { EnvironmentTestService } from '../modules/environments/EnvironmentTestService.js'
import { RequirementReviewService } from '../modules/requirements/RequirementReviewService.js'
import { DocInterviewService } from '../modules/docInterview/DocInterviewService.js'
import { ForkChatService } from '../modules/execution/ForkChatService.js'
import { TesterQualityReviewService } from '../modules/execution/TesterQualityReviewService.js'
import { KaizenService } from '../modules/kaizen/KaizenService.js'
import { ClarityReviewService } from '../modules/clarity/ClarityReviewService.js'
import { BrainstormService } from '../modules/brainstorm/BrainstormService.js'
import { NotificationService } from '../modules/notifications/NotificationService.js'
import { RiskPolicyService } from '../modules/merge/RiskPolicyService.js'
import { SandboxService } from '../modules/sandbox/SandboxService.js'
import { SandboxRunService } from '../modules/sandbox/SandboxRunService.js'
import { WorkspaceSettingsService } from '../modules/settings/WorkspaceSettingsService.js'
import { ReleaseHealthService } from '../modules/releaseHealth/ReleaseHealthService.js'
import { PackageRegistryService } from '../modules/packageRegistries/PackageRegistryService.js'
import { PreviewService } from '../modules/preview/PreviewService.js'
import { IncidentEnrichmentService } from '../modules/incidentEnrichment/IncidentEnrichmentService.js'
import {
  ModelPresetService,
  resolvePresetModelForKind,
} from '../modules/modelPresets/ModelPresetService.js'
import { ServiceFragmentDefaultsService } from '../modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'
import { RecurringPipelineService } from '../modules/recurring/RecurringPipelineService.js'
import { TrackerSettingsService } from '../modules/recurring/TrackerSettingsService.js'
import type {
  BootstrapModule,
  BrainstormModule,
  ClarityModule,
  CoreDependencies,
  DocumentsModule,
  EnvironmentsModule,
  FragmentLibraryModule,
  GitHubModule,
  IncidentEnrichmentModule,
  KaizenModule,
  ModelPresetsModule,
  NotificationsModule,
  PackageRegistriesModule,
  PreflightsModule,
  PreviewModule,
  RecurringModule,
  ReleaseHealthModule,
  RequirementsModule,
  RiskPoliciesModule,
  RunnersModule,
  SandboxModule,
  ServiceFragmentDefaultsModule,
  ServicesModule,
  SharedStacksModule,
  SlackModule,
  TasksModule,
  TrackerModule,
  WorkspaceSettingsModule,
} from '../container.js'

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
): DocumentsModule | undefined {
  const { documentSourceProviders, documentConnectionRepository, documentRepository } = deps
  if (
    !documentSourceProviders ||
    documentSourceProviders.length === 0 ||
    !documentConnectionRepository ||
    !documentRepository
  ) {
    return undefined
  }

  const registry = new MapDocumentSourceRegistry(documentSourceProviders)
  const connectionService = new DocumentConnectionService({
    documentConnectionRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
  })
  const importService = new DocumentImportService({
    registry,
    documentRepository,
    connectionService,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
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
  return { connectionService, importService, plannerService, linkService, contentResolver }
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
): TasksModule | undefined {
  const {
    taskSourceProviders,
    taskConnectionRepository,
    taskSourceSettingsRepository,
    taskRepository,
  } = deps
  if (
    !taskSourceProviders ||
    taskSourceProviders.length === 0 ||
    !taskConnectionRepository ||
    !taskSourceSettingsRepository ||
    !taskRepository
  ) {
    return undefined
  }

  const registry = new MapTaskSourceRegistry(taskSourceProviders)
  const connectionService = new TaskConnectionService({
    taskConnectionRepository,
    taskSourceSettingsRepository,
    registry,
    workspaceRepository: deps.workspaceRepository,
    clock: deps.clock,
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
        taskConnectionRepository,
        importService,
        linkService,
        taskRepository,
      })
    : undefined
  return {
    connectionService,
    importService,
    linkService,
    ...(bugIntakeService ? { bugIntakeService } : {}),
  }
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
  const userHandlerService = deps.environmentUserHandlerRepository
    ? new EnvironmentUserHandlerService({
        userHandlerRepository: deps.environmentUserHandlerRepository,
        environmentBackendRegistry:
          deps.environmentBackendRegistry ?? defaultEnvironmentBackendRegistry(),
        secretCipher,
        clock: deps.clock,
        ...(deps.environmentCustomTlsSupported !== undefined
          ? { customTlsSupported: deps.environmentCustomTlsSupported }
          : {}),
        ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
        ...(deps.logger ? { logger: deps.logger } : {}),
      })
    : undefined
  // Built BEFORE the provisioning service so it can be injected as `environmentTeardown` there:
  // a deployer re-run that supersedes a prior env with a DIFFERENT provider identity tears the old
  // infra down through this service (best-effort; the TTL reaper is the backstop).
  const teardownService = new EnvironmentTeardownService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    clock: deps.clock,
    ...(provisioningLog ? { provisioningLog } : {}),
  })
  const provisioningService = new EnvironmentProvisioningService({
    connectionService,
    environmentRegistryRepository,
    secretCipher,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    environmentTeardown: teardownService,
    ...(deps.environmentUrlSafetyPolicy ? { urlPolicy: deps.environmentUrlSafetyPolicy } : {}),
    ...(deps.resolveRunRepoContext ? { resolveRunRepoContext: deps.resolveRunRepoContext } : {}),
    ...(deps.resolveRepoFilesForCoords
      ? { resolveRepoFilesForWorkspace: deps.resolveRepoFilesForCoords }
      : {}),
    ...(userHandlerService
      ? {
          resolveUserHandlerOverrides: (userId, ws) =>
            userHandlerService.resolveOverrides(userId, ws),
        }
      : {}),
    // The async, container-backed deploy lifecycle (kustomize/helm) is wired when the facade
    // supplies the runner transport + the clone-target resolver; absent ⇒ only the synchronous
    // raw-manifest REST path runs (a render-needing config fails loudly).
    ...(deps.deployJobClient ? { deployJobClient: deps.deployJobClient } : {}),
    ...(deps.resolveDeployCloneTarget
      ? { resolveDeployCloneTarget: deps.resolveDeployCloneTarget }
      : {}),
    // A compose stack recipe's `sharedStackRefs` are brought up (provider-before-consumer) through
    // the shared-stack service, whose managed networks the compose provider attaches the per-PR
    // project to. Wired only when the shared-stacks module exists (its repository is present on
    // every facade); the lifecycle itself refuses without a host daemon.
    ...(sharedStackService
      ? { ensureSharedStacks: (ws, refs) => sharedStackService.ensureRefsUp(ws, refs) }
      : {}),
    // A compose stack recipe's `prerequisites` are re-run at provision start through the preflight
    // service, whose host probes exist only on the local facade; absent ⇒ a recipe that declares
    // them fails loudly instead of silently skipping a machine-prerequisite gate.
    ...(preflightService ? { runPreflights: (_ws, refs) => preflightService.run(refs) } : {}),
    ...(provisioningLog ? { provisioningLog } : {}),
  })
  // The ephemeral-environment self-test: needs its own run store + a git provider (to
  // create/delete the throwaway branch). Absent either ⇒ no self-test (the controller 503s).
  const environmentTest =
    deps.environmentTestRunRepository && deps.resolveRunRepoContext
      ? new EnvironmentTestService({
          environmentTestRunRepository: deps.environmentTestRunRepository,
          workspaceRepository: deps.workspaceRepository,
          blockRepository: deps.blockRepository,
          provisioning: provisioningService,
          teardown: teardownService,
          environmentRegistry: environmentRegistryRepository,
          resolveRunRepoContext: deps.resolveRunRepoContext,
          idGenerator: deps.idGenerator,
          clock: deps.clock,
          ...(deps.environmentTestRunner ? { runner: deps.environmentTestRunner } : {}),
          ...(eventPublisher ? { eventPublisher } : {}),
        })
      : undefined

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
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
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
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
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
export function createForkChatService(deps: CoreDependencies): ForkChatService | undefined {
  if (!deps.modelProviderResolver && !deps.modelProvider) return undefined
  return new ForkChatService({
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    resolveRunContext: resolveBlockRunContext(deps),
  })
}

/**
 * Resolve a block's active run (execution id + initiator) for the iterative reviewers, so an
 * inline subscription reviewer served through a leased per-run activation can lease it. Reads
 * the block's `executionId` and the run's `initiatedBy`; `{}` when the block has no active run
 * (an off-path inspector review with no pipeline) — the reviewer then resolves on a
 * workspace-only scope (pooled lease), unchanged.
 */
export function resolveBlockRunContext(
  deps: CoreDependencies,
): (workspaceId: string, block: Block) => Promise<{ executionId?: string; userId?: string }> {
  return async (workspaceId, block) => {
    if (!block.executionId) return {}
    const instance = await deps.executionRepository.get(workspaceId, block.executionId)
    return {
      executionId: block.executionId,
      ...(instance?.initiatedBy ? { userId: instance.initiatedBy } : {}),
    }
  }
}

export function createRequirementsModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
  fragmentLibrary?: FragmentLibraryModule,
): RequirementsModule | undefined {
  const { requirementReviewRepository } = deps
  if (!requirementReviewRepository) return undefined

  const service = new RequirementReviewService({
    requirementReviewRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    // Tell product people + the task creator to react to a review's findings (when
    // the notifications subsystem is wired). Best-effort; absent → no notification.
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    // The dedicated reviewer ref, else the document planner's (both the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    // Honour a block's pinned model with the direct/Cloudflare fallback, like the executor.
    resolveBlockModel: deps.requirementReviewResolveModel,
    // In local mode, run the reviewer inline through the ambient Claude Code / Codex CLI on a
    // subscription model instead of degrading to the routing default.
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Honour the workspace's model presets for the `requirements` kind too, so the
    // reviewer resolves its model exactly like a pipeline step. Reuses the already
    // wired model-preset repository (the workspace default preset); absent → only
    // block-pin + routing default.
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    // The reviewer runs during a parked run, so its execution + initiator come from the
    // block's active run — threaded into the model scope so an inline subscription ref served
    // through a leased per-run activation (local container inline backend) can lease it.
    resolveRunContext: resolveBlockRunContext(deps),
    documentRepository: deps.documentRepository,
    taskRepository: deps.taskRepository,
    // The Requirement Writer (second companion) grounds recommendations on the run's repo
    // (`spec/` + `tech-spec/` via the checkout-free RepoFiles) — wired in all three facades.
    resolveRunRepoContext: deps.resolveRunRepoContext,
    // …and on the block's best-practice fragments (team/org standards), checked FIRST. Walk
    // the owning frame's service standards then union the block's own pins (same precedence
    // as the agent context builder), resolved against the merged tenant catalog when the
    // fragment library is wired (so managed + document-backed fragments ground the review
    // exactly like they reach a code-aware run), else the static universal pool.
    resolveBlockFragments: async (workspaceId: string, blockId: string) => {
      const block = await deps.blockRepository.get(workspaceId, blockId)
      if (!block) return []
      const ids: string[] = []
      const seen = new Set<string>()
      const add = (id: string) => {
        if (!seen.has(id)) {
          seen.add(id)
          ids.push(id)
        }
      }
      let current: Block | null = block
      for (let i = 0; current && i < 8; i++) {
        if (current.level === 'frame' || !current.parentId) {
          for (const id of current.serviceFragmentIds ?? []) add(id)
          break
        }
        current = await deps.blockRepository.get(workspaceId, current.parentId)
      }
      for (const id of block.fragmentIds ?? []) add(id)
      if (fragmentLibrary) {
        // Resolve the merged tenant catalog ONCE and reuse it for both the titles map and
        // the body resolution (which would otherwise re-resolve the same catalog).
        const catalog = await fragmentLibrary.libraryService.resolveCatalog(workspaceId)
        const titles = new Map(catalog.map((e) => [e.id, e.title]))
        const bodies = await fragmentLibrary.libraryService.resolveBodiesForRun(
          workspaceId,
          ids,
          catalog,
        )
        return bodies.map(({ id, body }) => ({ id, title: titles.get(id) ?? id, body }))
      }
      const out: { id: string; title: string; body: string }[] = []
      for (const id of ids) {
        const fragment = getFragment(id)
        if (fragment) out.push({ id, title: fragment.title, body: fragment.body })
      }
      return out
    },
    // `webSearch` (gateway-RAG) is wired by the web-search-connection workstream; until then
    // the Writer still gets provider-hosted web search on Anthropic/OpenAI models.
    // When an upstream `requirements-brainstorm` dialogue settled a converged direction, the
    // reviewer critiques THAT (the refined requirements) instead of the raw description.
    resolveBrainstormDirection: deps.brainstormSessionRepository
      ? async (workspaceId: string, blockId: string) => {
          const session = await deps.brainstormSessionRepository!.getByBlockStage(
            workspaceId,
            blockId,
            'requirements',
          )
          return session?.status === 'incorporated' && session.convergedDirection
            ? session.convergedDirection
            : undefined
        }
      : undefined,
  })
  return { service }
}

/**
 * Assemble the brainstorm (structured-dialogue) module when its repository is present (both
 * runtime facades wire it unconditionally). Mirrors {@link createClarityModule}: it builds ONE
 * {@link BrainstormService} per stage (sharing the repository) and reuses the requirements
 * reviewer's model config since all the inline reviewers resolve their model identically. The
 * architecture stage seeds from the refined requirements (a requirements review's incorporated
 * doc, else the requirements-brainstorm's converged direction).
 */
export function createBrainstormModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): BrainstormModule | undefined {
  const { brainstormSessionRepository } = deps
  if (!brainstormSessionRepository) return undefined

  const resolveWorkspaceModelDefault = deps.modelPresetRepository
    ? (workspaceId: string, agentKind: string, modelPresetId?: string) =>
        resolvePresetModelForKind(
          deps.modelPresetRepository!,
          workspaceId,
          agentKind,
          modelPresetId,
        )
    : undefined

  // The architecture stage's seed: the most refined requirements available — a settled
  // requirements review's incorporated doc, else the requirements-brainstorm's direction.
  const resolveRefinedRequirements = async (
    workspaceId: string,
    blockId: string,
  ): Promise<string | undefined> => {
    const review = await deps.requirementReviewRepository?.getByBlock(workspaceId, blockId)
    if (review?.status === 'incorporated' && review.incorporatedRequirements) {
      return review.incorporatedRequirements
    }
    const session = await brainstormSessionRepository.getByBlockStage(
      workspaceId,
      blockId,
      'requirements',
    )
    return session?.status === 'incorporated' && session.convergedDirection
      ? session.convergedDirection
      : undefined
  }

  const common = {
    brainstormSessionRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Brainstorm stages are pipeline gate steps that run during a parked run, so their
    // execution + initiator come from the block's active run — threaded into the model scope
    // so an inline subscription ref served through a leased per-run activation (local container
    // inline backend) can lease it, exactly like the requirements/clarity reviewers.
    resolveRunContext: resolveBlockRunContext(deps),
    resolveWorkspaceModelDefault,
  }

  return {
    services: {
      requirements: new BrainstormService({ ...common, stage: 'requirements' }),
      architecture: new BrainstormService({
        ...common,
        stage: 'architecture',
        resolveRefinedRequirements,
      }),
    },
  }
}

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
    // Reuse the reviewer's routing default ref + block-model resolver (the agents' default).
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    // Resolve the workspace's per-kind default for `kaizen`, like a pipeline step.
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
  })
  return { service }
}

/**
 * Assemble the clarity-review module when its repository is present (both runtime facades
 * wire it unconditionally). Mirrors {@link createRequirementsModule}: it reuses the
 * requirements reviewer's model config (the same routing default) since both reviewers
 * resolve their model identically.
 */
export function createClarityModule(
  deps: CoreDependencies,
  notificationService?: NotificationService,
): ClarityModule | undefined {
  const { clarityReviewRepository } = deps
  if (!clarityReviewRepository) return undefined

  const service = new ClarityReviewService({
    clarityReviewRepository,
    blockRepository: deps.blockRepository,
    idGenerator: deps.idGenerator,
    clock: deps.clock,
    notificationService,
    modelProviderResolver: deps.modelProviderResolver,
    modelProvider: deps.modelProvider,
    modelRef: deps.requirementReviewModel ?? deps.documentPlannerModel,
    resolveBlockModel: deps.requirementReviewResolveModel,
    ...(deps.inlineHarnessRef ? { runsInline: deps.inlineHarnessRef } : {}),
    resolveWorkspaceModelDefault: deps.modelPresetRepository
      ? (workspaceId, agentKind, modelPresetId) =>
          resolvePresetModelForKind(
            deps.modelPresetRepository!,
            workspaceId,
            agentKind,
            modelPresetId,
          )
      : undefined,
    resolveRunContext: resolveBlockRunContext(deps),
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
 * Assemble the recurring-pipeline module when its repository is present. Built
 * after the execution engine since each fire starts a pipeline through it.
 */
export function createRecurringModule(
  deps: CoreDependencies,
  executionService: ExecutionService,
  executionEventPublisher: ExecutionEventPublisher,
  taskConnectionService?: TaskConnectionService,
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
  })
  return { service }
}
