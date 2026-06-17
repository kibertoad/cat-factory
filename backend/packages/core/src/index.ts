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
} from './modules/workspaces/WorkspaceService'
export {
  AccountService,
  type AccountServiceDependencies,
  type AccountUser,
} from './modules/accounts/AccountService'

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

export { AiAgentExecutor, type AiAgentExecutorDependencies } from './modules/agents/AiAgentExecutor'
export {
  type AgentModelConfig,
  type AgentRouting,
  resolveAgentConfig,
} from './modules/agents/agent-routing'
export { systemPromptFor, userPromptFor } from './modules/agents/agent-catalog'
export {
  type VersionedPrompt,
  type PromptId,
  PROMPT_VERSIONS,
  promptVersion,
  promptVersionLabel,
} from './modules/agents/prompt-versions'
export {
  composeSystemPrompt,
  composeBlockSystemPrompt,
  type ComposableBlock,
} from './modules/agents/prompt-fragments'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
} from './modules/agents/standard-prompts'
export {
  type AcceptanceAgentKind,
  ACCEPTANCE_AGENT_KINDS,
  acceptanceSystemPrompt,
  isAcceptanceKind,
  testApproachSection,
} from './modules/agents/acceptance-prompts'
export { MOCK_AGENT_KIND, isMockKind, mockSystemPrompt } from './modules/agents/mock-prompts'
export {
  type BusinessLogicAgentKind,
  BUSINESS_LOGIC_AGENT_KINDS,
  BUSINESS_DOCUMENTER_KIND,
  BUSINESS_REVIEWER_KIND,
  BUSINESS_LOGIC_DOCS_DIR,
  isBusinessLogicKind,
  businessLogicSystemPrompt,
} from './modules/agents/business-logic-prompts'

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
} from './modules/fragmentLibrary/FragmentLibraryService'
export {
  FragmentSourceService,
  type FragmentSourceServiceDependencies,
  type ResolveFragmentInstallationId,
} from './modules/fragmentLibrary/FragmentSourceService'
export { DeterministicFragmentSelector } from './modules/fragmentLibrary/DeterministicFragmentSelector'
export {
  type ResolvedCatalogEntry,
  mergeCatalog,
  toSelectable,
  entryToFragment,
  selectDeterministic,
} from './modules/fragmentLibrary/fragment-catalog'
export * as fragmentSourceLogic from './modules/fragmentLibrary/fragment-source.logic'

export {
  GitHubInstallationService,
  type GitHubInstallationServiceDependencies,
} from './modules/github/GitHubInstallationService'
export { GitHubService, type GitHubServiceDependencies } from './modules/github/GitHubService'
export {
  GitHubSyncService,
  type GitHubSyncServiceDependencies,
} from './modules/github/GitHubSyncService'
export { WebhookService, type WebhookServiceDependencies } from './modules/github/WebhookService'
export * as githubProjection from './modules/github/projection.logic'
export {
  RepoProvisioningService,
  type RepoProvisioningServiceDependencies,
  type DelegationReason,
  type ProvisionResult,
} from './modules/github/RepoProvisioningService'
export { canCreateRepo } from './modules/github/provisioning.logic'

export {
  DocumentConnectionService,
  type DocumentConnectionServiceDependencies,
} from './modules/documents/DocumentConnectionService'
export {
  DocumentImportService,
  type DocumentImportServiceDependencies,
  toSourceDocument,
} from './modules/documents/DocumentImportService'
export {
  DocumentPlannerService,
  type DocumentPlannerServiceDependencies,
} from './modules/documents/DocumentPlannerService'
export {
  DocumentLinkService,
  type DocumentLinkServiceDependencies,
  type SpawnResult,
} from './modules/documents/DocumentLinkService'
export { MapDocumentSourceRegistry } from './modules/documents/documents.logic'
export * as documentsLogic from './modules/documents/documents.logic'
export * as confluenceLogic from './modules/documents/confluence.logic'
export * as notionLogic from './modules/documents/notion.logic'
export { CONFLUENCE_DESCRIPTOR } from './modules/documents/confluence.logic'
export { NOTION_DESCRIPTOR } from './modules/documents/notion.logic'

export {
  TaskConnectionService,
  type TaskConnectionServiceDependencies,
} from './modules/tasks/TaskConnectionService'
export {
  TaskImportService,
  type TaskImportServiceDependencies,
  toSourceTask,
} from './modules/tasks/TaskImportService'
export { TaskLinkService, type TaskLinkServiceDependencies } from './modules/tasks/TaskLinkService'
export {
  MapTaskSourceRegistry,
  type TaskContextView,
  renderTaskContext,
  buildTaskExcerpt,
} from './modules/tasks/tasks.logic'
export * as tasksLogic from './modules/tasks/tasks.logic'
export * as jiraLogic from './modules/tasks/jira.logic'
export { JIRA_DESCRIPTOR } from './modules/tasks/jira.logic'

export {
  EnvironmentConnectionService,
  type EnvironmentConnectionServiceDependencies,
  type ResolvedConnection,
  referencedSecretKeys,
} from './modules/environments/EnvironmentConnectionService'
export {
  EnvironmentProvisioningService,
  type EnvironmentProvisioningServiceDependencies,
  type ProvisionArgs,
  type ResolvedEnvironment,
} from './modules/environments/EnvironmentProvisioningService'
export {
  EnvironmentTeardownService,
  type EnvironmentTeardownServiceDependencies,
} from './modules/environments/EnvironmentTeardownService'
export * as environmentsLogic from './modules/environments/environments.logic'

export {
  RunnerPoolConnectionService,
  type RunnerPoolConnectionServiceDependencies,
  type ResolvedRunnerPool,
} from './modules/runners/RunnerPoolConnectionService'
export * as runnersLogic from './modules/runners/runners.logic'

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
