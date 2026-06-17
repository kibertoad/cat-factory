// Public surface of the framework-agnostic core.

// Re-export kernel (backward compat: consumers of @cat-factory/core still get these)
export * from '@cat-factory/kernel'

export { BoardService, type BoardServiceDependencies } from './modules/board/BoardService'
export * as boardLogic from './modules/board/board.logic'
export {
  PipelineService,
  type PipelineServiceDependencies,
} from './modules/pipelines/PipelineService'
export {
  ExecutionService,
  type ExecutionServiceDependencies,
} from './modules/execution/ExecutionService'
export type { AdvanceOptions, AdvanceResult } from './modules/execution/advance'
export {
  WorkspaceService,
  type WorkspaceServiceDependencies,
  AccountService,
  type AccountServiceDependencies,
  type AccountUser,
} from '@cat-factory/workspaces'

export {
  SpendService,
  type SpendServiceDependencies,
  type RecordUsageInput,
  type ModelPrice,
  type SpendPricing,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  DEFAULT_SPEND_PRICING,
  priceFor,
  estimateCost,
  startOfMonthUtc,
} from '@cat-factory/spend'

// Re-export agents package (backward compat: consumers of @cat-factory/core still get these)
export {
  AiAgentExecutor,
  type AiAgentExecutorDependencies,
  type AgentModelConfig,
  type AgentRouting,
  resolveAgentConfig,
  systemPromptFor,
  userPromptFor,
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  REVIEW_SYSTEM_PROMPT,
  promptVersion,
  promptVersionLabel,
  composeSystemPrompt,
  composeBlockSystemPrompt,
  type ComposableBlock,
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
  MOCK_AGENT_KIND,
  isMockKind,
  mockSystemPrompt,
  type BusinessLogicAgentKind,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_REVIEWER_KIND,
  BUSINESS_LOGIC_DOCS_DIR,
  isBusinessLogicKind,
  businessLogicSystemPrompt,
  CI_RETRY_SANITY_CHECK,
} from '@cat-factory/agents'

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
  type FragmentLibraryModule,
  createCore,
} from './container'
export {
  RequirementReviewService,
  type RequirementReviewServiceDependencies,
} from './modules/requirements/RequirementReviewService'
export * as requirementsLogic from './modules/requirements/requirements.logic'

export {
  FragmentLibraryService,
  type FragmentLibraryServiceDependencies,
  FragmentSourceService,
  type FragmentSourceServiceDependencies,
  type ResolveFragmentInstallationId,
  DeterministicFragmentSelector,
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
  fragmentSourceLogic,
} from '@cat-factory/agents'

// Re-export integrations package (backward compat: consumers of @cat-factory/core still get these)
export {
  GitHubInstallationService,
  type GitHubInstallationServiceDependencies,
  GitHubService,
  type GitHubServiceDependencies,
  GitHubSyncService,
  type GitHubSyncServiceDependencies,
  WebhookService,
  type WebhookServiceDependencies,
  githubProjection,
  RepoProvisioningService,
  type RepoProvisioningServiceDependencies,
  type DelegationReason,
  type ProvisionResult,
  canCreateRepo,
  DocumentConnectionService,
  type DocumentConnectionServiceDependencies,
  DocumentImportService,
  type DocumentImportServiceDependencies,
  toSourceDocument,
  DocumentPlannerService,
  type DocumentPlannerServiceDependencies,
  DocumentLinkService,
  type DocumentLinkServiceDependencies,
  type SpawnResult,
  MapDocumentSourceRegistry,
  documentsLogic,
  confluenceLogic,
  notionLogic,
  CONFLUENCE_DESCRIPTOR,
  NOTION_DESCRIPTOR,
  TaskConnectionService,
  type TaskConnectionServiceDependencies,
  TaskImportService,
  type TaskImportServiceDependencies,
  toSourceTask,
  TaskLinkService,
  type TaskLinkServiceDependencies,
  MapTaskSourceRegistry,
  type TaskContextView,
  renderTaskContext,
  buildTaskExcerpt,
  tasksLogic,
  jiraLogic,
  JIRA_DESCRIPTOR,
  EnvironmentConnectionService,
  type EnvironmentConnectionServiceDependencies,
  type ResolvedConnection,
  referencedSecretKeys,
  EnvironmentProvisioningService,
  type EnvironmentProvisioningServiceDependencies,
  type ProvisionArgs,
  type ResolvedEnvironment,
  EnvironmentTeardownService,
  type EnvironmentTeardownServiceDependencies,
  environmentsLogic,
  RunnerPoolConnectionService,
  type RunnerPoolConnectionServiceDependencies,
  type ResolvedRunnerPool,
  runnersLogic,
} from '@cat-factory/integrations'

export {
  BootstrapService,
  type BootstrapServiceDependencies,
  type BootstrapPollResult,
} from './modules/bootstrap/BootstrapService'

export {
  BoardScanService,
  type BoardScanServiceDependencies,
} from './modules/boardScan/BoardScanService'
export * as boardScanLogic from './modules/boardScan/board-scan.logic'
