import type { Project, ProjectStage, ProjectStageState } from '@cat-factory/contracts'
import {
  type Block,
  type BlockRepository,
  ConflictError,
  type ProjectKindModuleRegistry,
  ValidationError,
  type WorkspaceRepository,
} from '@cat-factory/kernel'
import type { ProjectOutcomeStore } from './ProjectOutcomeStore.js'
import { tryDecodeOutcome } from './outcomeDecoding.js'

// The tasks a stage's result set going that must settle before a person accepts the result at the
// stage's checkpoint (a spawn stage's tasks in the project's services). The handler of the stage's
// task type names them (`checkpointAwaits`); a task settles once it is done or removed from every
// board, since removing it is a person deciding it will not be done. A task moved to another board
// of the account (a reparent into a service homed elsewhere) is still the work, so it is looked
// for there before its absence counts as removal.

export interface StageAwaitsDeps {
  outcomes: Pick<ProjectOutcomeStore, 'get'>
  modules: ProjectKindModuleRegistry
  blocks: Pick<BlockRepository, 'getMany'>
  workspaces: Pick<WorkspaceRepository, 'listByAccount'>
}

/**
 * The awaited tasks still on a board: one read per board they were created on, and, only for a
 * task missing there, one per other board of the project's account.
 */
async function awaitedTasks(
  deps: StageAwaitsDeps,
  project: Project,
  awaited: readonly { workspaceId: string; taskId: string }[],
): Promise<Block[]> {
  const byWorkspace = new Map<string, string[]>()
  for (const { workspaceId, taskId } of awaited) {
    byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), taskId])
  }
  const found = (
    await Promise.all(
      [...byWorkspace].map(([workspaceId, ids]) => deps.blocks.getMany(workspaceId, ids)),
    )
  ).flat()
  const seen = new Set(found.map((block) => block.id))
  const missing = awaited.map((a) => a.taskId).filter((id) => !seen.has(id))
  if (missing.length === 0 || project.accountId === null) return found
  const others = (await deps.workspaces.listByAccount(project.accountId)).filter(
    (w) => !byWorkspace.has(w.id),
  )
  const moved = await Promise.all(others.map((w) => deps.blocks.getMany(w.id, missing)))
  return [...found, ...moved.flat()]
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
  const unsettled = (await awaitedTasks(deps, project, handler.checkpointAwaits(decoded.body)))
    .filter((block) => block.status !== 'done')
    .map((block) => block.id)
  if (unsettled.length === 0) return
  throw new ConflictError(
    `Stage '${stage.id}' started tasks that have not finished`,
    'project_stage_work_unsettled',
    { stageId: stage.id, taskIds: unsettled },
  )
}
