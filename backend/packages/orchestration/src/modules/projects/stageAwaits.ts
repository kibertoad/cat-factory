import type { Project, ProjectStage, ProjectStageState } from '@cat-factory/contracts'
import {
  type BlockRepository,
  ConflictError,
  type ProjectKindModuleRegistry,
  ValidationError,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'

// The tasks a stage's result set going that must settle before a person accepts the result at the
// stage's checkpoint (a spawn stage's tasks in the project's services). The handler of the stage's
// task type names them (`checkpointAwaits`); a task settles once it is done or removed from its
// board, since removing it is a person deciding it will not be done.

export interface StageAwaitsDeps {
  outcomes: Pick<ProjectOutcomeStore, 'get'>
  modules: ProjectKindModuleRegistry
  blocks: Pick<BlockRepository, 'getMany'>
}

/** Refuse an acceptance while a task the result awaits has not settled. */
export async function assertAwaitedWorkSettled(
  deps: StageAwaitsDeps,
  input: { project: Project; stage: ProjectStage; state: ProjectStageState },
): Promise<void> {
  const { project, stage, state } = input
  const handler = deps.modules.handlerOf(project.kind, stage.taskType)
  if (!handler?.checkpointAwaits || !state.latest) return
  const stored = await deps.outcomes.get(project, state.latest.id)
  const decoded = stored ? tryDecodeOutcome(deps.modules, project.kind, stored) : undefined
  if (!decoded) {
    throw new ValidationError(`The result of stage '${stage.id}' cannot be read to accept it`, {
      reason: 'project_stage_result_unreadable',
      stageId: stage.id,
      outcomeId: state.latest.id,
    })
  }
  // One read per board the awaited tasks live on; a removed task is simply absent.
  const byWorkspace = new Map<string, string[]>()
  for (const { workspaceId, taskId } of handler.checkpointAwaits(decoded.body)) {
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), taskId])
  }
  const live = await Promise.all(
    [...byWorkspace].map(([workspaceId, ids]) => deps.blocks.getMany(workspaceId, ids)),
  )
  const unsettled = live
    .flat()
    .filter((block) => block.status !== 'done')
    .map((block) => block.id)
  if (unsettled.length === 0) return
  throw new ConflictError(
    `Stage '${stage.id}' started tasks that have not finished`,
    'project_stage_work_unsettled',
    { stageId: stage.id, taskIds: unsettled },
  )
}
