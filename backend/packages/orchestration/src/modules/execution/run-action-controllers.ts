import type { Block, PipelineStep } from '@cat-factory/kernel'
import { IterationCapController } from './IterationCapController.js'
import type { IterationCapDeps } from './IterationCapController.js'
import { RunLifecycleController } from './RunLifecycleController.js'
import type { RunLifecycleDeps } from './RunLifecycleController.js'

// The two collaborators that serve a HUMAN (or an API caller) acting on a run as a whole, rather
// than the driver advancing one: the lifecycle surface and the iteration-cap resolution.
//
// They are built together, and by a sibling factory rather than inline in the engine's
// constructor, for two reasons. The cap controller's `stop-reset` branch IS a run cancel, so
// binding it to the lifecycle controller HERE states that dependency in code instead of routing it
// back through a `this`-bound closure. And the pair arrives on the engine as ONE field, which is
// what keeps its constructor inside the `max-statements` budget (a budget is a split trigger).

/** What the engine passes in: its leaf collaborators plus the guards it owns. */
export interface RunActionControllerDeps
  extends
    Omit<RunLifecycleDeps, 'requireWorkspace' | 'requireBlock' | 'failRun'>,
    Pick<IterationCapDeps, 'stepGraph'> {
  requireWorkspace: RunLifecycleDeps['requireWorkspace']
  requireBlock: RunLifecycleDeps['requireBlock']
  failRun: RunLifecycleDeps['failRun']
  inferBlockTechnical: (
    workspaceId: string,
    block: Block,
    producer: PipelineStep,
    companionStep: PipelineStep,
  ) => Promise<void>
}

export interface RunActionControllers {
  lifecycle: RunLifecycleController
  iterationCap: IterationCapController
}

export function buildRunActionControllers(deps: RunActionControllerDeps): RunActionControllers {
  const lifecycle = new RunLifecycleController(deps)
  const iterationCap = new IterationCapController({
    blockRepository: deps.blockRepository,
    executionRepository: deps.executionRepository,
    runStateMachine: deps.runStateMachine,
    stepGraph: deps.stepGraph,
    workRunner: deps.workRunner,
    requireWorkspace: deps.requireWorkspace,
    // `stop-reset` tears the run down and returns the block to phase zero, which is exactly
    // `cancel`; the gate owns only the choice, never a second teardown path.
    cancelRun: (workspaceId, blockId) => lifecycle.cancel(workspaceId, blockId),
    inferBlockTechnical: deps.inferBlockTechnical,
  })
  return { lifecycle, iterationCap }
}
