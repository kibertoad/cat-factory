// Public surface of the delivery-workflow engine.

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
  type RaiseNotificationInput,
} from './modules/notifications/NotificationService.js'
export {
  MergePresetService,
  type MergePresetServiceDependencies,
} from './modules/merge/MergePresetService.js'
export {
  WorkspaceSettingsService,
  type WorkspaceSettingsServiceDependencies,
} from './modules/settings/WorkspaceSettingsService.js'
export {
  ReleaseHealthService,
  type ReleaseHealthServiceDependencies,
} from './modules/releaseHealth/ReleaseHealthService.js'
export {
  ModelDefaultsService,
  type ModelDefaultsServiceDependencies,
} from './modules/modelDefaults/ModelDefaultsService.js'
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
  type BootstrapModule,
  type RequirementsModule,
  type ClarityModule,
  type NotificationsModule,
  type ReleaseHealthModule,
  type SlackModule,
  type MergePresetsModule,
  type WorkspaceSettingsModule,
  type ModelDefaultsModule,
  type ServiceFragmentDefaultsModule,
  type FragmentLibraryModule,
  type RecurringModule,
  type TrackerModule,
  type ServicesModule,
  createCore,
} from './container.js'
