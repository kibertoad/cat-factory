import type { AppCaches } from '@cat-factory/kernel'
import { SpendService } from '@cat-factory/spend'
import type { CoreDependencies } from './dependencies.js'
import { ExecutionService } from '../modules/execution/ExecutionService.js'
import { createTesterQualityReviewer } from './modules.js'
import { makeDocumentUrlResolver } from '../modules/execution/linked-context.js'
import { resolvePresetModelForKind } from '../modules/modelPresets/ModelPresetService.js'
import { BoardScanService } from '../modules/boardScan/BoardScanService.js'
import { BoardService } from '../modules/board/BoardService.js'
import type { createEngineCollaborators } from './engine-collaborators.js'
import type { createPlatformModules } from './platform-modules.js'
import type { createCoreFoundation } from './foundation.js'
import type { resolveCoreRuntime } from './runtime.js'
import type { OptionalCoreModules } from '../container.js'

/**
 * Everything `createCore` has resolved by the time the engine is constructed. Grouped so the
 * ExecutionService wiring — the single largest literal in the composition root — can live beside
 * it rather than inside it, keeping that root within the per-function line budget. Purely a move:
 * every field is threaded exactly as it was.
 */
export interface ExecutionServiceWiringInput {
  dependencies: CoreDependencies
  runtime: ReturnType<typeof resolveCoreRuntime>
  caches: AppCaches
  boardService: BoardService
  spendService: SpendService
  settings: ReturnType<typeof createCoreFoundation>['settings']
  notifications: ReturnType<typeof createCoreFoundation>['notifications']
  mergeTrackRecords: OptionalCoreModules['mergeTrackRecords'] | undefined
  blueprintReconciler: BoardScanService
  platform: ReturnType<typeof createPlatformModules>
  collaborators: ReturnType<typeof createEngineCollaborators>
}

/** Construct the engine from the already-resolved core spine, modules and collaborators. */
export function buildExecutionService(input: ExecutionServiceWiringInput): ExecutionService {
  const {
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
  } = input
  const { llmObservability, environments, foundationalServices, fragmentLibrary, skillLibrary } =
    platform
  const {
    initiativeService,
    initiativeInterviewService,
    requirements,
    docInterview,
    forkChat,
    judgeAssessor,
    clarity,
    brainstorm,
    kaizen,
    tasks,
    pokeInitiativeLoop,
  } = collaborators

  return new ExecutionService({
    ...dependencies,
    agentKindRegistry: runtime.agentKindRegistry,
    gateRegistry: runtime.gateRegistry,
    judgeRegistry: runtime.judgeRegistry,
    judgeAssessor,
    stepResolverRegistry: runtime.stepResolverRegistry,
    providerRegistry: runtime.providerRegistry,
    initiativePresetRegistry: runtime.initiativePresetRegistry,
    workRunner: runtime.workRunner,
    executionEventPublisher: runtime.executionEventPublisher,
    boardService,
    pokeInitiativeLoop,
    bugIntakeService: tasks?.bugIntakeService,
    spendService,
    // Read-through slice for `resolveRiskPolicy` (the merge preset re-read on every gate
    // evaluation); `RiskPolicyService` invalidates it on every preset write.
    riskPolicyCache: caches.riskPolicy,
    // The per-class change classification the merge policy's rules key off, plus the best-effort
    // record of every merge decision. Absent ⇒ `unknown` class, no rule matches, nothing stored.
    mergeTrackRecord: mergeTrackRecords?.service,
    // Route runtime fragment-id resolution through the merged tenant catalog (so
    // managed + document-backed fragments reach a run), present only when the
    // library is configured; otherwise the engine falls back to the static pool.
    fragmentResolver: fragmentLibrary?.libraryService,
    // Route a `skill` step's skill resolution (instructions + resource bodies at the pinned
    // commit) through the skill library, present only when it's configured; a skill step
    // dispatched without it fails loudly rather than running blank.
    skillResolver: skillLibrary?.runResolver,
    // The foundational-services catalog seam: the design-time catalog folded into an
    // architect's context, and the lazily-resolved contract documents folded into its
    // consumers'. Absent ⇒ neither is injected, which is byte-for-byte the prior behaviour.
    foundationalServiceResolver: foundationalServices?.runResolver,
    // The deployment's generative binary integrations — what a binary-generating step PRODUCES
    // with, as the catalog above is where the product GOES. In-process composition data, so it is
    // threaded unconditionally (empty by default) rather than gated on a configured module.
    binaryGeneratorSource: runtime.binaryGenerators,
    // Canonicalise a URL pasted into a block description to the document's stable
    // (source, externalId) via the providers' parseRef, so a Figma/Notion/etc. link
    // auto-matches its imported page even with a title segment or tracking params the
    // stored canonical url omits. Absent providers → undefined (url-string match only).
    documentUrlResolver: makeDocumentUrlResolver(dependencies.documentSourceProviders),
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
    runLifecycleSink: dependencies.runLifecycleSink,
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
}
