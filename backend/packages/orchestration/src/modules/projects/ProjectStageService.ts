import {
  type BlockEditAuthority,
  deriveProjectStageStates,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  type Project,
  type ProjectDefinition,
  type ProjectStage,
  type ProjectStageState,
  type ProjectStageTask,
  type ProjectStageView,
  upstreamOf,
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
import { resolvePinnedDefinition } from './pinnedDefinition.js'

// ---------------------------------------------------------------------------
// The stages of a project whose pinned definition declares them: where each stands, starting a
// stage's task, and a person accepting a stage's result at its checkpoint. A stage's state is
// DERIVED (`deriveProjectStageStates`) from the stage-task records and the project's outcomes, so
// nothing here stores a status, and a read never writes. Design:
// `docs/initiatives/staged-project-definitions.md`.
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

/** Starts a task's run on the pipeline the task pins, with no person behind it. */
export type StageRunStarter = (
  workspaceId: string,
  blockId: string,
  pipelineId: string,
) => Promise<unknown>

export interface ProjectStageServiceDeps {
  getMounted: (workspaceId: string, projectId: string) => Promise<MountedProject>
  listTasks: (project: Project) => Promise<Block[]>
  records: Pick<
    ProjectRecordRepository,
    | 'getPin'
    | 'listOutcomes'
    | 'listStageTasks'
    | 'insertStageTask'
    | 'markStageTaskRecorded'
    | 'clearStageCheckpoint'
    | 'deleteStageTasks'
  >
  definitions: ProjectDefinitionSource
  /** Late-bound: the board is built after the projects module. */
  board: () => StageTaskBoard | undefined
  /** Late-bound: starts a task's run; the engine is built after the projects module. */
  runStarter: () => StageRunStarter | undefined
  clock: Clock
  logger?: Logger
}

/** The outcome facts a stage's state reads. */
type OutcomeFacts = ReadonlyArray<{
  id: string
  seq: number
  stream: string
  taskId: string | null
}>

/** Everything a stage write reads before it decides. */
interface StageSnapshot {
  stages: readonly ProjectStage[]
  states: ProjectStageState[]
  stageTasks: ProjectStageTask[]
  liveTaskIds: Set<string>
  outcomes: OutcomeFacts
}

export class ProjectStageService {
  private readonly log: Logger

  constructor(private readonly deps: ProjectStageServiceDeps) {
    this.log = deps.logger ?? noopLogger
  }

  /**
   * Each stage of a project's pinned definition with where it stands, in the definition's order,
   * from the outcomes the caller already read. Empty for a definition that declares no stages.
   */
  async views(
    project: Project,
    definition: ProjectDefinition | null,
    outcomes: OutcomeFacts,
  ): Promise<ProjectStageView[]> {
    const stages = definition?.stages ?? []
    if (stages.length === 0) return []
    const { states } = await this.snapshot(project, stages, outcomes)
    return stages.map((stage, i) => {
      const { config: _config, ...shown } = stage
      return { stage: shown, state: states[i]! }
    })
  }

  /**
   * Start a stage: create its task under the project root and bind the task to the stage, with the
   * upstream results it starts from. Refused unless the stage is `ready`, or `done` and
   * repeatable. Two concurrent starts race on the stage's one open slot; the loser's task is
   * removed again.
   */
  async createTask(
    workspaceId: string,
    projectId: string,
    stageId: string,
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block> {
    const { project, rootBlock, homeWorkspaceId } = await this.deps.getMounted(
      workspaceId,
      projectId,
    )
    const snapshot = await this.snapshot(project, await this.stagesOf(project))
    const index = snapshot.stages.findIndex((s) => s.id === stageId)
    const stage = snapshot.stages[index]
    if (!stage) throw new NotFoundError('ProjectStage', stageId)
    assertStartable(stage, snapshot.states[index]!)
    const board = this.deps.board()
    // An invariant of the composition root, not a refusal: the board is wired before any request.
    if (!board) throw new Error('The board is not wired, so a stage cannot create its task')
    const block = await board.addTask(
      workspaceId,
      rootBlock.id,
      {
        title: stage.title,
        ...(stage.description ? { description: stage.description } : {}),
        taskType: stage.taskType,
      },
      editor,
      createdBy,
    )
    const record: ProjectStageTask = {
      taskId: block.id,
      projectId,
      stageId,
      createdAt: this.deps.clock.now(),
      basis: basisOf(stage, snapshot),
      recordedAt: null,
      clearedAt: null,
      clearedBy: null,
    }
    const claimed =
      (await this.deps.records.insertStageTask(record)) ||
      ((await this.freeStaleSlot(project, stageId, snapshot.stages)) &&
        (await this.deps.records.insertStageTask(record)))
    if (claimed) return block
    await runBestEffort(
      this.log,
      'projects.stage.rollbackTask',
      () => board.removeTask(homeWorkspaceId, block.id),
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
   * Start every stage whose definition starts it on its own (`start: 'auto'`) and that is ready
   * now: create its task and start the task's run. Called when a project is created, after an
   * outcome records and after a checkpoint clears. Idempotent: a stage already running is not
   * ready, and a concurrent advance that claims the same stage first wins it. A stage that fails
   * to start is logged and stays `ready` for a person.
   */
  async advance(workspaceId: string, projectId: string): Promise<void> {
    const { project, homeWorkspaceId } = await this.deps.getMounted(workspaceId, projectId)
    const snapshot = await this.snapshot(project, await this.stagesOf(project))
    const due = snapshot.stages.filter(
      (stage, i) => stage.start === 'auto' && snapshot.states[i]!.status === 'ready',
    )
    for (const stage of due) {
      await runBestEffort(
        this.log,
        'projects.stages.autoStart',
        () => this.autoStart(homeWorkspaceId, projectId, stage),
        { projectId, stageId: stage.id },
      )
    }
  }

  private async autoStart(
    homeWorkspaceId: string,
    projectId: string,
    stage: ProjectStage,
  ): Promise<void> {
    let task: Block
    try {
      // No person authors an automatic stage's task, so no one's tier narrows its merge policy.
      task = await this.createTask(
        homeWorkspaceId,
        projectId,
        stage.id,
        UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
        null,
      )
    } catch (error) {
      // Another advance claimed the stage first: it starts the run, so there is nothing to do.
      if (error instanceof ConflictError && error.details?.reason === 'project_stage_in_progress') {
        return
      }
      throw error
    }
    const start = this.deps.runStarter()
    if (!task.pipelineId || !start) {
      throw new Error(`Stage '${stage.id}' created task '${task.id}' but cannot start its run`)
    }
    await start(homeWorkspaceId, task.id, task.pipelineId)
  }

  /**
   * Accept a stage's newest result at its checkpoint, so the stages after it count it. Refused
   * unless the stage is awaiting its checkpoint.
   */
  async clearCheckpoint(
    workspaceId: string,
    projectId: string,
    stageId: string,
    userId: string | null,
  ): Promise<ProjectStageState> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const stages = await this.stagesOf(project)
    const index = stages.findIndex((s) => s.id === stageId)
    if (index < 0) throw new NotFoundError('ProjectStage', stageId)
    const before = (await this.snapshot(project, stages)).states[index]!
    const latest = before.status === 'awaiting-checkpoint' ? before.latest : null
    let cleared = false
    if (latest) {
      // The result is on record, so its task has recorded: say so first, in case the write that
      // freed its stage never landed and the acceptance below would find nothing to accept.
      const now = this.deps.clock.now()
      await this.deps.records.markStageTaskRecorded(projectId, latest.taskId, now)
      cleared = await this.deps.records.clearStageCheckpoint(projectId, latest.taskId, now, userId)
    }
    if (!cleared) {
      throw new ConflictError(
        'This stage has no result waiting for its checkpoint',
        'project_stage_checkpoint_not_pending',
        { stageId, status: before.status },
      )
    }
    await runBestEffort(
      this.log,
      'projects.stages.advanceOnCheckpoint',
      () => this.advance(workspaceId, projectId),
      { projectId, stageId },
    )
    return (await this.snapshot(project, stages)).states[index]!
  }

  /** The stages of the definition the project pinned, refused when that definition changed. */
  private async stagesOf(project: Project): Promise<readonly ProjectStage[]> {
    const pin = await this.deps.records.getPin(project.id)
    if (!pin) return []
    return (await resolvePinnedDefinition(this.deps.definitions, project, pin)).stages
  }

  /**
   * What a stage decision reads. The stage-task records are read BEFORE the live tasks: a task is
   * created before its record, so every record this read sees has its task in the next one, and a
   * task being created concurrently can never read as deleted.
   */
  private async snapshot(
    project: Project,
    stages: readonly ProjectStage[],
    known?: OutcomeFacts,
  ): Promise<StageSnapshot> {
    const stageTasks = await this.deps.records.listStageTasks(project.id)
    const [tasks, outcomes] = await Promise.all([
      this.deps.listTasks(project),
      known ? Promise.resolve(known) : this.deps.records.listOutcomes(project.id),
    ])
    const liveTaskIds = new Set(tasks.map((t) => t.id))
    const states = deriveProjectStageStates({ stages, stageTasks, liveTaskIds, outcomes })
    return { stages, states, stageTasks, liveTaskIds, outcomes }
  }

  /**
   * After a lost claim, free the stage's slot when the record holding it can no longer finish: its
   * task was deleted before it recorded, or it recorded but the write saying so never landed.
   * Answers whether the slot is free now, so the caller claims once more.
   */
  private async freeStaleSlot(
    project: Project,
    stageId: string,
    stages: readonly ProjectStage[],
  ): Promise<boolean> {
    const now = await this.snapshot(project, stages)
    const holder = now.stageTasks.find((t) => t.stageId === stageId && t.recordedAt === null)
    if (!holder) return true
    if (now.outcomes.some((o) => o.taskId === holder.taskId)) {
      await this.deps.records.markStageTaskRecorded(
        project.id,
        holder.taskId,
        this.deps.clock.now(),
      )
      return true
    }
    if (!now.liveTaskIds.has(holder.taskId)) {
      await this.deps.records.deleteStageTasks(project.id, [holder.taskId])
      return true
    }
    return false
  }
}

/** The accepted result of each upstream stage, by stage id, which `stale` later compares. */
function basisOf(stage: ProjectStage, snapshot: StageSnapshot): Record<string, string | null> {
  const byId = new Map(snapshot.states.map((s) => [s.stageId, s] as const))
  return Object.fromEntries(
    upstreamOf(stage).map((id) => [id, byId.get(id)?.accepted?.id ?? null] as const),
  )
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
