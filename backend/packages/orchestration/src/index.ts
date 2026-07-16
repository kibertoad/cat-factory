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
  UI_TESTER_AGENT_KIND,
  TESTER_KINDS,
  isTesterKind,
  FIXER_AGENT_KIND,
  VISUAL_CONFIRM_AGENT_KIND,
  type CiVerdict,
} from './modules/execution/ci.logic.js'
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
} from './modules/modelPresets/ModelPresetService.js'
export {
  ServiceFragmentDefaultsService,
  type ServiceFragmentDefaultsServiceDependencies,
} from './modules/serviceFragmentDefaults/ServiceFragmentDefaultsService.js'

export {
  LlmObservabilityService,
  type LlmObservabilityServiceDependencies,
  type RecordLlmCallInput,
  type HarnessCallsRecordInput,
  makeHarnessCallRecorder,
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
  type RiskPoliciesModule,
  type SharedStacksModule,
  type PreflightsModule,
  type SandboxModule,
  type WorkspaceSettingsModule,
  type ModelPresetsModule,
  type ServiceFragmentDefaultsModule,
  type FragmentLibraryModule,
  type SkillLibraryModule,
  type InitiativesModule,
  type RecurringModule,
  type TrackerModule,
  type ServicesModule,
  createCore,
} from './container.js'
