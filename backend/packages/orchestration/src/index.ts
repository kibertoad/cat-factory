// Public surface of the delivery-workflow engine.

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
  BootstrapService,
  type BootstrapServiceDependencies,
  type BootstrapPollResult,
} from './modules/bootstrap/BootstrapService'

export {
  BoardScanService,
  type BoardScanServiceDependencies,
} from './modules/boardScan/BoardScanService'
export * as boardScanLogic from './modules/boardScan/board-scan.logic'

export {
  RequirementReviewService,
  type RequirementReviewServiceDependencies,
} from './modules/requirements/RequirementReviewService'
export * as requirementsLogic from './modules/requirements/requirements.logic'

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
