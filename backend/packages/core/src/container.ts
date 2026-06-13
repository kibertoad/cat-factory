import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  WorkspaceRepository,
} from './ports/repositories'
import type { Clock, IdGenerator } from './ports/runtime'
import type { AgentExecutor } from './ports/agent-executor'
import type { TokenUsageRepository } from './ports/token-usage'
import { type WorkRunner, NoopWorkRunner } from './ports/work-runner'
import { BoardService } from './modules/board/BoardService'
import { ExecutionService } from './modules/execution/ExecutionService'
import { PipelineService } from './modules/pipelines/PipelineService'
import { WorkspaceService } from './modules/workspaces/WorkspaceService'
import { SpendService } from './modules/spend/SpendService'
import { DEFAULT_SPEND_PRICING, type SpendPricing } from './modules/spend/pricing'

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
  /** Ledger backing the spend safeguard (per-call token usage). */
  tokenUsageRepository: TokenUsageRepository
  /**
   * Drives runs durably outside the starting request. Defaults to a no-op (tick
   * mode); the worker wires WorkflowsWorkRunner when execution mode is workflow.
   */
  workRunner?: WorkRunner
  /**
   * Pricing and budget for the spend safeguard. Defaults to the built-in
   * approximate EUR prices and a ~100 EUR/month limit; the worker overrides
   * this from env, and tests can inject a tiny limit to exercise pausing.
   */
  spendPricing?: SpendPricing
}

export interface Core {
  workspaceService: WorkspaceService
  boardService: BoardService
  pipelineService: PipelineService
  executionService: ExecutionService
  spendService: SpendService
}

export function createCore(dependencies: CoreDependencies): Core {
  const workRunner = dependencies.workRunner ?? new NoopWorkRunner()
  const boardService = new BoardService(dependencies)
  const workspaceService = new WorkspaceService(dependencies)
  const pipelineService = new PipelineService(dependencies)
  const spendService = new SpendService({
    tokenUsageRepository: dependencies.tokenUsageRepository,
    idGenerator: dependencies.idGenerator,
    clock: dependencies.clock,
    pricing: dependencies.spendPricing ?? DEFAULT_SPEND_PRICING,
  })
  const executionService = new ExecutionService({
    ...dependencies,
    workRunner,
    boardService,
    spendService,
  })

  return { workspaceService, boardService, pipelineService, executionService, spendService }
}
