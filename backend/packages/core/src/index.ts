// Public surface of the framework-agnostic core.

export * from './domain/types'
export {
  DomainError,
  NotFoundError,
  ValidationError,
  ConflictError,
  assertFound,
  type DomainErrorCode,
} from './domain/errors'
export { DEFAULT_CONFIDENCE_THRESHOLD, DECISION_CHANCE } from './domain/catalog'
export {
  type SelectableModel,
  type ModelVariant,
  type DirectKeyAvailable,
  MODEL_CATALOG,
  getSelectableModel,
  effectiveCatalog,
  resolveModelRef,
} from './domain/models'
export { seedBlocks, seedPipelines } from './domain/seed'

export * from './ports'

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
  requireWorkspace,
  type WorkspaceServiceDependencies,
} from './modules/workspaces/WorkspaceService'

export {
  SpendService,
  type SpendServiceDependencies,
  type RecordUsageInput,
} from './modules/spend/SpendService'
export {
  type ModelPrice,
  type SpendPricing,
  DEFAULT_MODEL_PRICES,
  DEFAULT_MONTHLY_LIMIT_EUR,
  DEFAULT_SPEND_PRICING,
  priceFor,
  estimateCost,
  startOfMonthUtc,
} from './modules/spend/pricing'

export { AiAgentExecutor, type AiAgentExecutorDependencies } from './modules/agents/AiAgentExecutor'
export {
  SimulatorAgentExecutor,
  type SimulatorAgentExecutorDependencies,
} from './modules/agents/SimulatorAgentExecutor'
export {
  type AgentModelConfig,
  type AgentRouting,
  resolveAgentConfig,
} from './modules/agents/agent-routing'
export { systemPromptFor, userPromptFor } from './modules/agents/agent-catalog'
export { composeSystemPrompt } from './modules/agents/prompt-fragments'
export {
  type StandardPhase,
  STANDARD_PHASES,
  STANDARD_PHASE_BY_KIND,
  phaseForKind,
  standardSystemPrompt,
  renderStandardUserPrompt,
} from './modules/agents/standard-prompts'

export {
  type Core,
  type CoreDependencies,
  type GitHubModule,
  type ConfluenceModule,
  createCore,
} from './container'

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
  ConfluenceConnectionService,
  type ConfluenceConnectionServiceDependencies,
} from './modules/confluence/ConfluenceConnectionService'
export {
  ConfluenceImportService,
  type ConfluenceImportServiceDependencies,
  toConfluenceDocument,
} from './modules/confluence/ConfluenceImportService'
export {
  ConfluencePlannerService,
  type ConfluencePlannerServiceDependencies,
} from './modules/confluence/ConfluencePlannerService'
export {
  ConfluenceLinkService,
  type ConfluenceLinkServiceDependencies,
  type SpawnResult,
} from './modules/confluence/ConfluenceLinkService'
export * as confluenceLogic from './modules/confluence/confluence.logic'
