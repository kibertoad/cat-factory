import {
  type BlockEditAuthority,
  deriveProjectStageStates,
  type Project,
  type ProjectDefinition,
  type ProjectStage,
  type ProjectStageState,
  type ProjectStageView,
} from '@cat-factory/contracts'
import {
  type Block,
  type Clock,
  ConflictError,
  type Logger,
  NotFoundError,
  noopLogger,
  type ProjectDefinitionSource,
  type ProjectRecordRepository,
  runBestEffort,
} from '@cat-factory/kernel'
import type { MountedProject } from './ProjectService.js'

// ---------------------------------------------------------------------------
// The stages of a project whose pinned definition declares them: where each stands, starting a
// stage's task, and a person accepting a stage's result at its checkpoint. A stage's state is
// DERIVED (`deriveProjectStageStates`) from the stage-task records and the project's outcomes, so
// nothing here stores a status. Design: `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** Creates and removes a task block under a project root, on the board that homes it. */
export interface StageTaskBoard {
  addTask(
    workspaceId: string,
    rootBlockId: string,
    input: { title: string; description?: string; taskType: string },
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block>
  removeTask(homeWorkspaceId: string, blockId: string): Promise<void>
}

export interface ProjectStageServiceDeps {
  getMounted: (workspaceId: string, projectId: string) => Promise<MountedProject>
  listTasks: (project: Project) => Promise<Block[]>
  records: Pick<
    ProjectRecordRepository,
    | 'getPin'
    | 'listOutcomes'
    | 'listStageTasks'
    | 'insertStageTask'
    | 'clearStageCheckpoint'
    | 'deleteStageTasks'
  >
  definitions: ProjectDefinitionSource
  /** Late-bound: the board is built after the projects module. */
  board: () => StageTaskBoard | undefined
  clock: Clock
  logger?: Logger
}

/** A stage as a reader of its project sees it: the definition's stage and where it stands. */
interface ResolvedStages {
  project: Project
  homeWorkspaceId: string
  rootBlockId: string
  stages: readonly ProjectStage[]
  states: ProjectStageState[]
}

export class ProjectStageService {
  private readonly log: Logger

  constructor(private readonly deps: ProjectStageServiceDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Each stage of a project's pinned definition with where it stands, in the definition's order.
   * Empty for a project whose definition declares no stages, or that pins none.
   */
  async views(project: Project, definition: ProjectDefinition | null): Promise<ProjectStageView[]> {
    const stages = definition?.stages ?? []
    if (stages.length === 0) return []
    const states = await this.statesOf(project, stages)
    return stages.map((stage, i) => {
      const { config: _config, ...shown } = stage
      return { stage: shown, state: states[i]! }
    })
  }

  /**
   * Start a stage: create its task under the project root and bind the task to the stage. Refused
   * unless the stage is `ready`, or `done` and repeatable. Two concurrent starts race on the
   * stage's one open slot, and the loser's task is removed again.
   */
  async createTask(
    workspaceId: string,
    projectId: string,
    stageId: string,
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block> {
    const resolved = await this.resolve(workspaceId, projectId)
    const index = resolved.stages.findIndex((s) => s.id === stageId)
    const stage = resolved.stages[index]
    if (!stage) throw new NotFoundError('ProjectStage', stageId)
    assertStartable(stage, resolved.states[index]!)
    const board = this.deps.board()
    if (!board) throw new Error('The board is not wired, so a stage cannot create its task')
    const block = await board.addTask(
      workspaceId,
      resolved.rootBlockId,
      {
        title: stage.title,
        ...(stage.description ? { description: stage.description } : {}),
        taskType: stage.taskType,
      },
      editor,
      createdBy,
    )
    const claimed = await this.deps.records.insertStageTask({
      taskId: block.id,
      projectId,
      stageId,
      createdAt: this.deps.clock.now(),
      recordedAt: null,
      clearedAt: null,
      clearedBy: null,
    })
    if (claimed) return block
    await runBestEffort(
      this.log,
      'projects.stage.rollbackTask',
      () => board.removeTask(resolved.homeWorkspaceId, block.id),
      { projectId, stageId, blockId: block.id },
    )
    throw new ConflictError(
      'Another task of this stage started first',
      'project_stage_in_progress',
      {
        stageId,
      },
    )
  }

  /**
   * Accept a stage's newest result at its checkpoint, so stages after it count it. Refused unless
   * the stage is awaiting its checkpoint.
   */
  async clearCheckpoint(
    workspaceId: string,
    projectId: string,
    stageId: string,
    userId: string | null,
  ): Promise<ProjectStageState> {
    const resolved = await this.resolve(workspaceId, projectId)
    const index = resolved.stages.findIndex((s) => s.id === stageId)
    const state = resolved.states[index]
    if (!state) throw new NotFoundError('ProjectStage', stageId)
    const latest = state.status === 'awaiting-checkpoint' ? state.latest : null
    const cleared =
      latest !== null &&
      (await this.deps.records.clearStageCheckpoint(
        projectId,
        latest.taskId,
        this.deps.clock.now(),
        userId,
      ))
    if (!cleared) {
      throw new ConflictError(
        'This stage has no result waiting for its checkpoint',
        'project_stage_checkpoint_not_pending',
        { stageId, status: state.status },
      )
    }
    const after = await this.resolve(workspaceId, projectId)
    return after.states[index]!
  }

  private async resolve(workspaceId: string, projectId: string): Promise<ResolvedStages> {
    const { project, rootBlock, homeWorkspaceId } = await this.deps.getMounted(
      workspaceId,
      projectId,
    )
    const definition = await this.pinnedDefinition(project)
    const stages = definition?.stages ?? []
    return {
      project,
      homeWorkspaceId,
      rootBlockId: rootBlock.id,
      stages,
      states: stages.length ? await this.statesOf(project, stages) : [],
    }
  }

  private async pinnedDefinition(project: Project): Promise<ProjectDefinition | null> {
    const pin = await this.deps.records.getPin(project.id)
    if (!pin) return null
    const resolved = await this.deps.definitions.get(
      project.accountId ?? '',
      project.kind,
      pin.definitionKey,
      pin.definitionVersion,
    )
    return resolved?.definition ?? null
  }

  /**
   * Each stage's state. A record whose task was deleted before it recorded an outcome still holds
   * its stage's open slot, so it is dropped here: the deleted task can never record one.
   */
  private async statesOf(
    project: Project,
    stages: readonly ProjectStage[],
  ): Promise<ProjectStageState[]> {
    const [stageTasks, tasks, outcomes] = await Promise.all([
      this.deps.records.listStageTasks(project.id),
      this.deps.listTasks(project),
      this.deps.records.listOutcomes(project.id),
    ])
    const liveTaskIds = new Set(tasks.map((t) => t.id))
    const orphaned = stageTasks.filter((t) => t.recordedAt === null && !liveTaskIds.has(t.taskId))
    if (orphaned.length) {
      await this.deps.records.deleteStageTasks(
        project.id,
        orphaned.map((t) => t.taskId),
      )
    }
    return deriveProjectStageStates({ stages, stageTasks, liveTaskIds, outcomes })
  }
}

function assertStartable(stage: ProjectStage, state: ProjectStageState): void {
  if (state.status === 'ready') return
  if (state.status === 'done' && stage.repeatable) return
  const reason =
    state.status === 'in-progress'
      ? 'project_stage_in_progress'
      : state.status === 'blocked'
        ? 'project_stage_blocked'
        : state.status === 'awaiting-checkpoint'
          ? 'project_stage_awaiting_checkpoint'
          : 'project_stage_not_repeatable'
  throw new ConflictError(`Stage '${stage.id}' cannot start a task now`, reason, {
    stageId: stage.id,
    status: state.status,
    waitingOn: state.waitingOn,
  })
}
