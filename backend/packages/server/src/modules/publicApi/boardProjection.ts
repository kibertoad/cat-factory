import type { Block, PublicService, PublicTask } from '@cat-factory/contracts'

// The `Block` → public-resource projections, shared by every controller that answers with one.
//
// Their own module because there are now two: the task lifecycle (`PublicApiController`) and board
// provisioning (`PublicBoardController`) both hand a block back, and a projection defined beside one
// of them is a projection the other copies. That copy is the failure mode worth avoiding rather than
// a tidiness point: a field added to `publicTask` in one place and not the other does not fail to
// compile: the second surface simply keeps serving a response the contract says has the field, and
// a consumer reads its absence as the value being unset.

/** Project a board task block onto the external task resource. */
export function toPublicTask(block: Block, serviceId: string): PublicTask {
  return {
    taskId: block.id,
    serviceId,
    title: block.title,
    description: block.description,
    taskType: block.taskType ?? 'feature',
    status: block.status,
    progress: block.progress,
    // The public name is `runId`, one vocabulary with `publicRun.runId` and `/runs/:runId/...`;
    // `executionId` is the internal engine name for the same id.
    runId: block.executionId,
    pullRequestUrl: block.pullRequest?.url ?? null,
    dependsOn: block.dependsOn,
    // Absent is OFF, which is what the engine's post-merge hook reads it as: a task nobody has
    // toggled leaves its dependents to be started deliberately.
    autoStartDependents: block.autoStartDependents === true,
  }
}

/** Project a service frame block onto the external service resource. */
export function toPublicService(frame: Block): PublicService {
  return {
    serviceId: frame.id,
    title: frame.title,
    description: frame.description,
    type: frame.type,
    status: frame.status,
  }
}
