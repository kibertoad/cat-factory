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
  aggregateCi,
  isCiGreen,
  describeFailingChecks,
  CI_AGENT_KIND,
  REQUIREMENTS_WRITER_AGENT_KIND,
  CI_FIXER_AGENT_KIND,
  MERGER_AGENT_KIND,
  CONFLICTS_AGENT_KIND,
  CONFLICT_RESOLVER_AGENT_KIND,
  ANALYSIS_AGENT_KIND,
  TRACKER_AGENT_KIND,
  type CiVerdict,
} from './modules/execution/ci.logic.js'

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
  ModelDefaultsService,
  type ModelDefaultsServiceDependencies,
} from './modules/modelDefaults/ModelDefaultsService.js'

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
  type Core,
  type CoreDependencies,
  type GitHubModule,
  type DocumentsModule,
  type TasksModule,
  type EnvironmentsModule,
  type RunnersModule,
  type BootstrapModule,
  type BoardScanModule,
  type RequirementsModule,
  type NotificationsModule,
  type MergePresetsModule,
  type ModelDefaultsModule,
  type FragmentLibraryModule,
  type RecurringModule,
  type TrackerModule,
  type ServicesModule,
  createCore,
} from './container.js'
