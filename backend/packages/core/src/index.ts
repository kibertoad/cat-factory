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
  AiAgentExecutor,
  type AiAgentExecutorDependencies,
} from './modules/agents/AiAgentExecutor'
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

export { type Core, type CoreDependencies, createCore } from './container'
