// Public surface of the delivery-workflow engine.

// Boot-time validation of a deployment's registered extensions (gates / agent kinds /
// pipelines). A facade calls `validateRegistrationsOnce()` after all `register*` imports +
// provider wiring, before serving.
export {
  type RegistrationProblem,
  type ValidateRegistrationsOptions,
  collectRegistrationProblems,
  validateRegistrations,
  validateRegistrationsOnce,
  resetRegistrationValidationGuard,
} from './validation/validateRegistrations.js'

export { BoardService, type BoardServiceDependencies } from './modules/board/BoardService.js'
export * as boardLogic from './modules/board/board.logic.js'

export {
  PipelineService,
  type PipelineServiceDependencies,
} from './modules/pipelines/PipelineService.js'

export {
  ExecutionService,
  type ExecutionServiceDependencies,
} from './modules/execution/ExecutionService.js'
export type { AdvanceOptions, AdvanceResult } from './modules/execution/advance.js'
// The gate / step-resolver extension seams live in @cat-factory/kernel (so a deployment
// package can register one without depending on this package); re-exported here for
// discovery alongside the engine they extend.
export {
  type GateProbe,
  type GateHelperOutcome,
  type GateExhaustedArgs,
  type GateDefinition,
  type GateContext,
  type GateFactory,
  recordGateAttempt,
  registerGate,
  registeredGateFactories,
  clearRegisteredGates,
  stubGateContext,
  type StepResolverContext,
  type StepResolution,
  type StepCompletionResolver,
  type ResolverContext,
  type StepResolverFactory,
  registerStepResolver,
  registeredStepResolverFactories,
  clearRegisteredStepResolvers,
  stubResolverContext,
} from '@cat-factory/kernel'
export {
  driveExecution,
  type DriveConfig,
  type DriveLogger,
  type DriveOptions,
  type DriveOutcome,
} from './modules/execution/drive.js'
export {
  aggregateCi,
  isCiGreen,
  describeFailingChecks,
  CI_AGENT_KIND,
  SPEC_WRITER_AGENT_KIND,
  BLUEPRINTS_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  MERGER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  ANALYSIS_AGENT_KIND,
  TRACKER_AGENT_KIND,
  TESTER_AGENT_KIND,
  FIXER_AGENT_KIND,
  type CiVerdict,
} from './modules/execution/ci.logic.js'
export {
  POST_RELEASE_HEALTH_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  classifyReleaseHealth,
  describeRegressedSignals,
  type ReleaseGateVerdict,
} from './modules/execution/release.logic.js'
// A runtime facade tags an eviction it knows to be transient infra churn with this
// marker so the engine's job.logic classifier recovers it on the larger budget.
export { TRANSIENT_EVICTION_MARKER } from './modules/execution/job.logic.js'

export {
  RecurringPipelineService,
  type RecurringPipelineServiceDependencies,
} from './modules/recurring/RecurringPipelineService.js'
export {
  TrackerSettingsService,
  type TrackerSettingsServiceDependencies,
} from './modules/recurring/TrackerSettingsService.js'
export * as scheduleLogic from './modules/recurring/schedule.logic.js'

export {
  NotificationService,
  type NotificationServiceDependencies,
} from './modules/notifications/NotificationService.js'
// `RaiseNotificationInput` lives in @cat-factory/kernel (so runtime-neutral extension
// seams — e.g. a custom gate's `onExhausted` — can build one without depending on this
// package); surfaced here for discovery alongside the NotificationService that consumes it.
export type { RaiseNotificationInput } from '@cat-factory/kernel'
export {
  MergePresetService,
  type MergePresetServiceDependencies,
} from './modules/merge/MergePresetService.js'
export {
  SandboxService,
  type SandboxServiceDependencies,
  type SandboxExperimentDetail,
  type SandboxOverview,
  MAX_SANDBOX_CELLS,
} from './modules/sandbox/SandboxService.js'
export {
  SandboxRunService,
  type SandboxRunServiceDependencies,
} from './modules/sandbox/SandboxRunService.js'
export * as sandboxLogic from './modules/sandbox/sandbox.logic.js'
export {
  WorkspaceSettingsService,
  type WorkspaceSettingsServiceDependencies,
} from './modules/settings/WorkspaceSettingsService.js'
export {
  ReleaseHealthService,
  type ReleaseHealthServiceDependencies,
} from './modules/releaseHealth/ReleaseHealthService.js'
export {
  IncidentEnrichmentService,
  type IncidentEnrichmentServiceDependencies,
} from './modules/incidentEnrichment/IncidentEnrichmentService.js'
export {
  ModelPresetService,
  type ModelPresetServiceDependencies,
  resolvePresetModelForKind,
} from './modules/modelPresets/ModelPresetService.js'
export {
  ServiceFragmentDefaultsService,
  type ServiceFragmentDefaultsServiceDependencies,
} from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'

export {
  LlmObservabilityService,
  type LlmObservabilityServiceDependencies,
  type RecordLlmCallInput,
} from './modules/observability/LlmObservabilityService.js'
export {
  classifyCall,
  isWarningFinishReason,
  outputHeadroomRatio,
  transportOverheadRatio,
  buildLlmMetricsExport,
  type LlmCallOutcome,
} from './modules/observability/observability.logic.js'

export {
  BootstrapService,
  type BootstrapServiceDependencies,
  type BootstrapPollResult,
} from './modules/bootstrap/BootstrapService.js'

export {
  BoardScanService,
  type BoardScanServiceDependencies,
} from './modules/boardScan/BoardScanService.js'
export * as boardScanLogic from './modules/boardScan/board-scan.logic.js'

export {
  RequirementReviewService,
  type RequirementReviewServiceDependencies,
} from './modules/requirements/RequirementReviewService.js'
export * as requirementsLogic from './modules/requirements/requirements.logic.js'

export {
  ClarityReviewService,
  type ClarityReviewServiceDependencies,
} from './modules/clarity/ClarityReviewService.js'
export * as clarityLogic from './modules/clarity/clarity.logic.js'

export {
  type Core,
  type CoreDependencies,
  type GitHubModule,
  type DocumentsModule,
  type TasksModule,
  type EnvironmentsModule,
  type RunnersModule,
  type ProvisioningLogsModule,
  type BootstrapModule,
  type RequirementsModule,
  type ClarityModule,
  type NotificationsModule,
  type ReleaseHealthModule,
  type IncidentEnrichmentModule,
  type SlackModule,
  type MergePresetsModule,
  type SandboxModule,
  type WorkspaceSettingsModule,
  type ModelPresetsModule,
  type ServiceFragmentDefaultsModule,
  type FragmentLibraryModule,
  type RecurringModule,
  type TrackerModule,
  type ServicesModule,
  createCore,
} from './container.js'
