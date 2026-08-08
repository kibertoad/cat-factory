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
export { sweepBinaryArtifactRetention } from './modules/artifacts/artifactRetention.js'

export {
  PipelineService,
  type PipelineServiceDependencies,
} from './modules/pipelines/PipelineService.js'

export {
  ExecutionService,
  type ExecutionServiceDependencies,
} from './modules/execution/ExecutionService.js'
export type { TesterQualityReviewer } from './modules/execution/TesterQualityReviewService.js'
// The default judge assessor (the inline LLM verdict producer). Exported so a facade or a test
// harness can build/replace it explicitly; `createCore` builds one from the model-provider deps
// by default, so a deployment normally never names it. See `docs/initiatives/judge-registry.md`.
export { JudgeService, type JudgeServiceDeps } from './modules/execution/JudgeService.js'
export type { TesterQualityOutcome } from './modules/execution/testerQuality.logic.js'
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
  GateRegistry,
  defaultGateRegistry,
  stubGateContext,
  type StepResolverContext,
  type StepResolution,
  type StepCompletionResolver,
  type ResolverContext,
  type StepResolverFactory,
  StepResolverRegistry,
  defaultStepResolverRegistry,
  stubResolverContext,
  type JudgeRubric,
  type JudgeSubject,
  type JudgeAssessor,
  type JudgeDefinition,
  type JudgeContext,
  type JudgeFactory,
  JudgeRegistry,
  defaultJudgeRegistry,
  stubJudgeContext,
} from '@cat-factory/kernel'
export {
  driveExecution,
  type DriveConfig,
  type DriveOptions,
  type DriveOutcome,
  type StepOutcome,
} from './modules/execution/drive.js'
export {
  failureFromAdvanceError,
  failureFromDriver,
  failureFromResult,
  type RunFailure,
} from './modules/execution/runFailure.js'
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
  UI_TESTER_AGENT_KIND,
  TESTER_KINDS,
  isTesterKind,
  FIXER_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
  type CiVerdict,
} from './modules/execution/ci.logic.js'
export {
  dedicatedParkSurface,
  findParkedInterviewStep,
  type DedicatedParkSurface,
} from './modules/execution/step-park.logic.js'
export type { InterviewGate, InterviewView } from './modules/execution/InterviewGateController.js'
export { followUpLoopBudget } from './modules/execution/followUp.logic.js'
export {
  POST_RELEASE_HEALTH_AGENT_KIND,
  ON_CALL_AGENT_KIND,
  classifyReleaseHealth,
  describeRegressedSignals,
  type ReleaseGateVerdict,
} from './modules/execution/release.logic.js'
export {
  resolveFrontendBindings,
  buildFrontendRunNotes,
  hasLiveServiceBinding,
  hasServiceBinding,
  boundServiceFrameIds,
  indexLiveServiceEnvUrls,
  type ResolvedFrontendBinding,
  type LiveEnvHandle,
} from './modules/execution/frontend-infra.logic.js'

export {
  RecurringPipelineService,
  type RecurringPipelineServiceDependencies,
} from './modules/recurring/RecurringPipelineService.js'
export {
  InitiativeService,
  type InitiativeServiceDependencies,
} from './modules/initiative/InitiativeService.js'
export * as initiativeLogic from './modules/initiative/initiative.logic.js'
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
  RiskPolicyService,
  type RiskPolicyServiceDependencies,
} from './modules/merge/RiskPolicyService.js'
export {
  MergeTrackRecordService,
  type MergeTrackRecordServiceDependencies,
  type RecordMergeDecisionInput,
} from './modules/merge/MergeTrackRecordService.js'
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
  TutorialProgressService,
  type TutorialProgressServiceDependencies,
} from './modules/tutorial/TutorialProgressService.js'
export {
  MAX_DISTINCT_TOURS,
  OTHER_TOUR,
  TutorialTelemetryService,
  type TutorialTelemetryServiceDependencies,
} from './modules/tutorial/TutorialTelemetryService.js'
export {
  ReleaseHealthService,
  type ReleaseHealthServiceDependencies,
} from './modules/releaseHealth/ReleaseHealthService.js'
export {
  PackageRegistryService,
  PACKAGE_REGISTRY_CIPHER_INFO,
  resolvePackageRegistriesForDispatch,
  type PackageRegistryServiceDependencies,
  type DispatchPackageRegistry,
} from './modules/packageRegistries/PackageRegistryService.js'
export {
  PreviewService,
  type PreviewServiceDependencies,
  type PreviewJobPlan,
  type BuildPreviewJob,
} from './modules/preview/PreviewService.js'
export {
  IncidentEnrichmentService,
  type IncidentEnrichmentServiceDependencies,
} from './modules/incidentEnrichment/IncidentEnrichmentService.js'
export {
  ModelPresetService,
  type ModelPresetServiceDependencies,
  resolvePresetModelForKind,
  resolvePresetProviderPreference,
} from './modules/modelPresets/ModelPresetService.js'
export {
  ConsensusGroupService,
  type ConsensusGroupServiceDependencies,
} from './modules/consensusGroups/ConsensusGroupService.js'
export {
  AgentPromptService,
  type AgentPromptServiceDependencies,
} from './modules/agentPrompts/AgentPromptService.js'
export {
  WorkspaceAgentSettingsService,
  type WorkspaceAgentSettingsServiceDependencies,
} from './modules/agentSettings/WorkspaceAgentSettingsService.js'
export {
  suppressedTaskTypeIds,
  TaskTypeSuppressionService,
  type TaskTypeSuppressionServiceDependencies,
  type TaskTypeSuppressionView,
} from './modules/taskTypes/TaskTypeSuppressionService.js'
export {
  ServiceFragmentDefaultsService,
  type ServiceFragmentDefaultsServiceDependencies,
} from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'

export {
  LlmObservabilityService,
  type LlmObservabilityServiceDependencies,
  type RecordLlmCallInput,
  type HarnessCallsRecordInput,
  // Exported for the same reason `MAX_AGENT_CONTEXT_TOTAL_CHARS` below is: a transport that moves
  // whole rows has to size its own limits against what capture can store, and deriving them from
  // the one ceiling beats a second copy that drifts (see `MAX_TELEMETRY_READ_CHARS`).
  MAX_BODY_CHARS,
  makeHarnessCallRecorder,
  makeInlineCallRecorder,
} from './modules/observability/LlmObservabilityService.js'
export {
  AgentContextObservabilityService,
  type AgentContextObservabilityServiceDependencies,
  MAX_AGENT_CONTEXT_CHARS,
  MAX_AGENT_CONTEXT_TOTAL_CHARS,
} from './modules/observability/AgentContextObservabilityService.js'
export {
  SearchQueryObservabilityService,
  type SearchQueryObservabilityServiceDependencies,
  MAX_SEARCH_QUERY_CHARS,
} from './modules/observability/SearchQueryObservabilityService.js'
export {
  ToolCallObservabilityService,
  type ToolCallObservabilityServiceDependencies,
  type ToolCallsRecordInput,
  makeToolCallRecorder,
  MAX_TOOL_BODY_CHARS,
} from './modules/observability/ToolCallObservabilityService.js'
export {
  PlatformObservabilityService,
  type PlatformObservabilityServiceDependencies,
} from './modules/observability/PlatformObservabilityService.js'
export {
  ReportsService,
  type ReportsServiceDependencies,
} from './modules/reports/ReportsService.js'
export {
  REPORT_WINDOWS,
  buildSpendTrend,
  foldTotals,
  toActivityRow,
  toSpendRow,
} from './modules/reports/reports.logic.js'
export {
  DAY_MS,
  PLATFORM_WINDOWS,
  buildTrend,
  dailyFailureSlices,
  dailyTrendRows,
  summarizeGateOutcomes,
  summarizeOutcomes,
} from './modules/observability/platform-observability.logic.js'
export {
  GateOutcomeRecorder,
  type GateOutcomeRecorderDeps,
  type SettledGate,
} from './modules/observability/GateOutcomeRecorder.js'
export {
  sweepPlatformMetrics,
  distinctAccountIds,
  type PlatformMetricsSink,
  type PlatformMetricsSweepDeps,
} from './modules/observability/platformMetricsSweep.js'
export {
  RUN_DAY_ROLLUP_LOOKBACK_MS,
  createRetentionPass,
  materializeSpendRollup,
  type RetentionPass,
} from './modules/observability/retentionPass.js'
export {
  flushOperationalMetrics,
  type OperationalMetricsFlushDeps,
  type OperationalMetricsSink,
} from './modules/observability/operationalMetricsFlush.js'
export {
  DEFAULT_PLATFORM_ALERT_THRESHOLDS,
  alertsHaveRunEvidence,
  evaluatePlatformHealth,
  platformAlertFailureKinds,
  platformAlertReasons,
  platformHealthCardContent,
  resolveAccountAlertConfig,
  type PlatformAlertThresholds,
  type ResolvedAccountAlertConfig,
} from './modules/observability/platform-health.logic.js'
export {
  spendThresholdCardContent,
  type SpendAlertSubject,
} from './modules/spend/spend-alert.logic.js'
export {
  cacheHitRate,
  classifyLlmCallOutcome,
  isLlmWarningFinishReason,
  outputHeadroomRatio,
  transportOverheadRatio,
  buildLlmMetricsExport,
  type LlmCallOutcome,
} from './modules/observability/observability.logic.js'
export {
  RunDebugService,
  type DebugCursor,
  type DebugPage,
  type RunDebugServiceDependencies,
} from './modules/debug/RunDebugService.js'
export {
  MAX_EVICTION_DETAIL_CHARS,
  deriveSignals,
  foldLlmRollup,
  sliceText,
  toDebugAgentContextDetail,
  toDebugAgentContextEntry,
  toDebugLlmCall,
  toDebugRunStep,
  toDebugRunSummary,
} from './modules/debug/debug.logic.js'

export {
  BootstrapService,
  type BootstrapServiceDependencies,
  type BootstrapPollResult,
} from './modules/bootstrap/BootstrapService.js'

export {
  EnvConfigRepairService,
  type EnvConfigRepairServiceDependencies,
  type EnvConfigRepairPollResult,
  type StartEnvConfigRepairInput,
} from './modules/envConfigRepair/EnvConfigRepairService.js'

export {
  EnvironmentTestService,
  type EnvironmentTestServiceDependencies,
  type EnvironmentTestPollResult,
} from './modules/environments/EnvironmentTestService.js'

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

export { KaizenService, type KaizenServiceDependencies } from './modules/kaizen/KaizenService.js'
export * as kaizenLogic from './modules/kaizen/kaizen.logic.js'

export {
  ClarityReviewService,
  type ClarityReviewServiceDependencies,
} from './modules/clarity/ClarityReviewService.js'
export * as clarityLogic from './modules/clarity/clarity.logic.js'

export {
  BrainstormService,
  type BrainstormServiceDependencies,
} from './modules/brainstorm/BrainstormService.js'
export * as brainstormLogic from './modules/brainstorm/brainstorm.logic.js'

export {
  type Core,
  type CoreSpine,
  type OptionalCoreModules,
  type CoreDependencies,
  type GitHubModule,
  type DocumentsModule,
  type TasksModule,
  type EnvironmentsModule,
  type RunnersModule,
  type ProvisioningLogsModule,
  type BootstrapModule,
  type RequirementsModule,
  type KaizenModule,
  type ClarityModule,
  type BrainstormModule,
  type NotificationsModule,
  type ReleaseHealthModule,
  type PackageRegistriesModule,
  type PreviewModule,
  type IncidentEnrichmentModule,
  type SlackModule,
  type MergeTrackRecordModule,
  type RiskPoliciesModule,
  type SharedStacksModule,
  type PreflightsModule,
  type SandboxModule,
  type WorkspaceSettingsModule,
  type ModelPresetsModule,
  type ConsensusGroupsModule,
  type AgentPromptsModule,
  type TaskTypeSuppressionModule,
  type WorkspaceAgentSettingsModule,
  type ServiceFragmentDefaultsModule,
  type FragmentLibraryModule,
  type SkillLibraryModule,
  type FoundationalServiceModule,
  type InitiativesModule,
  type RecurringModule,
  type TrackerModule,
  type ServicesModule,
  createCore,
} from './container.js'
