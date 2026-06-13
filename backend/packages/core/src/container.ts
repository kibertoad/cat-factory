import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from './ports/repositories'
import type { Clock, IdGenerator } from './ports/runtime'
import type { AgentExecutor } from './ports/agent-executor'
import { BoardService } from './modules/board/BoardService'
import { ExecutionService } from './modules/execution/ExecutionService'
import { PipelineService } from './modules/pipelines/PipelineService'
import { WorkspaceService } from './modules/workspaces/WorkspaceService'

// Composition root for the domain layer. The worker's infrastructure builds the
// concrete ports (D1 repositories, crypto id/rng, the AI agent executor) and
// hands them here; `createCore` wires the module services together in dependency
// order and returns them. This is the framework-agnostic equivalent of the
// template's per-module DI config, minus the awilix machinery.

export interface CoreDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * Performs each pipeline step. Wire AiAgentExecutor for real work,
   * SimulatorAgentExecutor for the playful local experience, or a fake in tests.
   */
  agentExecutor: AgentExecutor
}

export interface Core {
  workspaceService: WorkspaceService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
}

export function createCore(dependencies: CoreDependencies): Core {
  const boardService = new BoardService(dependencies)
  const workspaceService = new WorkspaceService(dependencies)
  const pipelineService = new PipelineService(dependencies)
  const executionService = new ExecutionService({ ...dependencies, boardService })

  return { workspaceService, boardService, pipelineService, executionService }
}
