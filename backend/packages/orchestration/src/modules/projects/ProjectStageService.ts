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
  type StageOutcomeFact,
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
import { type StageAwaitsDeps, assertAwaitedWorkSettled } from './stageAwaits.js'
import { type StageRevisionDeps, settleStageRevision } from './stageRevision.js'

// ---------------------------------------------------------------------------
// The stages of a project whose pinned definition declares them: where each stands, starting a
// stage's task, and a person accepting a stage's result at its checkpoint. A stage's state is
// DERIVED (`deriveProjectStageStates`) from the stage-task records and the project's outcomes, so
// nothing here stores a status, and a read never writes. Design:
// `docs/initiatives/staged-project-definitions.md`.
// ---------------------------------------------------------------------------

/** Creates and removes a task block under a container, on the board that homes it. */
export interface StageTaskBoard {
  addTask(
    workspaceId: string,
    containerId: string,
    input: { title: string; description?: string; taskType: string },
    editor: BlockEditAuthority,
    createdBy: string | null,
    /** An id the caller derived, so a replayed creation finds the task it made before. */
    opts?: { id?: string },
  ): Promise<Block>
  removeTask(homeWorkspaceId: string, blockId: string): Promise<void>
}

/** What starting an automatic stage's run needs of the engine. */
export interface StageRunStarter {
  /** The individual-usage vendors a run of the task would lease a personal credential for. */
  individualVendorsForBlock(
    workspaceId: string,
    blockId: string,
    pipelineId: string,
  ): Promise<readonly string[]>
  /** Start the task's run on the pipeline it pins, with no person behind it. */
  start(workspaceId: string, blockId: string, pipelineId: string): Promise<unknown>
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
    | 'markStageTaskRecorded'
    | 'clearStageCheckpoint'
    | 'deleteStageTasks'
    | 'reserveSeq'
  >
  /** Where a revised result is written, and the handlers that apply a revision. */
  outcomes: StageRevisionDeps['outcomes'] & StageAwaitsDeps['outcomes']
  /** Reads the tasks a result awaits before it may be accepted, on whichever board holds them. */
  blocks: StageAwaitsDeps['blocks']
  workspaces: StageAwaitsDeps['workspaces']
  modules: StageRevisionDeps['modules']
  definitions: ProjectDefinitionSource
  /** Late-bound: the board is built after the projects module. */
  board: () => StageTaskBoard | undefined
  /** Late-bound: starts a task's run; the engine is built after the projects module. */
  runStarter: () => StageRunStarter | undefined
  clock: Clock
  logger?: Logger
}

/**
 * `homedOnly` refuses a board that only mounts the project, for a caller (an API key) whose board
 * may act on a project's tasks only where the project is homed.
 */
export interface HomedOnly {
  homedOnly?: boolean
}

function assertHomed(mounted: MountedProject, workspaceId: string, opts: HomedOnly): void {
  if (!opts.homedOnly || mounted.homeWorkspaceId === workspaceId) return
  throw new ConflictError(
    "A project's tasks are created and run on the board that homes it",
    'project_homed_elsewhere',
    { projectId: mounted.project.id },
  )
}

/** The outcome facts a stage's state reads. */
type OutcomeFacts = ReadonlyArray<StageOutcomeFact>

/** Everything a stage write reads before it decides. */
interface StageSnapshot {
  stages: readonly ProjectStage[]
  /** The project's live tasks by id. */
  tasks: Map<string, Block>
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
    return viewsOf(stages, states)
  }

  /**
   * The stages of a project's pinned definition with where each stands, read from scratch. A read
   * serves the pinned version even when it changed since, and nothing when it is gone, as the
   * board's view does; starting a stage or accepting one is what refuses a changed definition.
   */
  async list(workspaceId: string, projectId: string): Promise<ProjectStageView[]> {
    const { project } = await this.deps.getMounted(workspaceId, projectId)
    const pin = await this.deps.records.getPin(project.id)
    const resolved = pin
      ? await this.deps.definitions.get(
          project.accountId ?? '',
          project.kind,
          pin.definitionKey,
          pin.definitionVersion,
        )
      : null
    const stages = resolved?.definition.stages ?? []
    if (stages.length === 0) return []
    return viewsOf(stages, (await this.snapshot(project, stages)).states)
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
    opts: HomedOnly = {},
  ): Promise<Block> {
    const mounted = await this.deps.getMounted(workspaceId, projectId)
    assertHomed(mounted, workspaceId, opts)
    const snapshot = await this.snapshot(mounted.project, await this.stagesOf(mounted.project))
    const index = snapshot.stages.findIndex((s) => s.id === stageId)
    const stage = snapshot.stages[index]
    if (!stage) throw new NotFoundError('ProjectStage', stageId)
    assertStartable(stage, snapshot.states[index]!)
    return this.createFor(workspaceId, mounted, snapshot, stage, editor, createdBy)
  }

  /**
   * Start what the definition starts on its own (`start: 'auto'`). An automatic stage starts
   * ONCE, when it first becomes ready and no task of it exists yet: after that a person decides,
   * so deleting its task stops it rather than inviting the next trigger to recreate it. A task an
   * automatic stage created whose run never started (the process died between the two, or the
   * start failed) has its run started here instead, so every trigger resumes rather than strands
   * it. Called when a project is created, after an outcome records and after a checkpoint clears;
   * each stage is best-effort, and one that cannot start is logged with its task left on the board
   * for a person to start.
   */
  async advance(workspaceId: string, projectId: string): Promise<void> {
    const mounted = await this.deps.getMounted(workspaceId, projectId)
    const stages = await this.stagesOf(mounted.project)
    if (!stages.some((s) => s.start === 'auto')) return
    const snapshot = await this.snapshot(mounted.project, stages)
    for (const [i, stage] of stages.entries()) {
      if (stage.start !== 'auto') continue
      const state = snapshot.states[i]!
      const active = state.activeTaskId ? snapshot.tasks.get(state.activeTaskId) : undefined
      const unstarted = active && active.executionId === null ? active : undefined
      const due =
        state.status === 'ready' && !snapshot.stageTasks.some((t) => t.stageId === stage.id)
      if (!due && !unstarted) continue
      await runBestEffort(
        this.log,
        'projects.stages.autoStart',
        async () => {
          const task =
            unstarted ??
            (await this.createFor(
              mounted.homeWorkspaceId,
              mounted,
              snapshot,
              stage,
              // No person authors an automatic stage's task, so no tier narrows its merge policy.
              UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
              null,
            ))
          await this.startRun(mounted.homeWorkspaceId, stage, task)
        },
        { projectId, stageId: stage.id },
      )
    }
  }

  /** Start an automatic stage's task's run, unless it needs a person to start it. */
  private async startRun(homeWorkspaceId: string, stage: ProjectStage, task: Block): Promise<void> {
    const runs = this.deps.runStarter()
    if (!runs) throw new Error('The engine is not wired, so a stage cannot start its run')
    if (!task.pipelineId) {
      throw new Error(`Stage '${stage.id}' task '${task.id}' pins no pipeline; a person starts it`)
    }
    // A personal subscription is leased by the person who starts a run, and nobody starts this
    // one, so such a run is left on the board for a person rather than failing at its first step.
    const [vendor] = await runs.individualVendorsForBlock(homeWorkspaceId, task.id, task.pipelineId)
    if (vendor) {
      throw new Error(
        `Stage '${stage.id}' runs on an individual-usage ${vendor} model, which cannot start ` +
          'unattended; its task waits on the board for a person to start',
      )
    }
    await runs.start(homeWorkspaceId, task.id, task.pipelineId)
  }

  /** Create a stage's task and claim the stage's open slot for it, from reads already made. */
  private async createFor(
    workspaceId: string,
    { project, rootBlock, homeWorkspaceId }: MountedProject,
    snapshot: StageSnapshot,
    stage: ProjectStage,
    editor: BlockEditAuthority,
    createdBy: string | null,
  ): Promise<Block> {
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
      projectId: project.id,
      stageId: stage.id,
      createdAt: this.deps.clock.now(),
      basis: basisOf(stage, snapshot),
      recordedAt: null,
      clearedAt: null,
      clearedBy: null,
      acceptedOutcomeId: null,
    }
    const claimed =
      (await this.deps.records.insertStageTask(record)) ||
      ((await this.freeStaleSlot(project, stage.id, snapshot.stages)) &&
        (await this.deps.records.insertStageTask(record)))
    if (claimed) return block
    await runBestEffort(
      this.log,
      'projects.stage.rollbackTask',
      () => board.removeTask(homeWorkspaceId, block.id),
      { projectId: project.id, stageId: stage.id, blockId: block.id },
    )
    throw new ConflictError(
      'Another task of this stage started first',
      'project_stage_in_progress',
      {
        stageId: stage.id,
      },
    )
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
    revision?: unknown,
    opts: HomedOnly = {},
  ): Promise<ProjectStageState> {
    const mounted = await this.deps.getMounted(workspaceId, projectId)
    assertHomed(mounted, workspaceId, opts)
    const { project, homeWorkspaceId } = mounted
    const stages = await this.stagesOf(project)
    const index = stages.findIndex((s) => s.id === stageId)
    if (index < 0) throw new NotFoundError('ProjectStage', stageId)
    const envelopes = await this.deps.records.listOutcomes(project.id)
    const before = (await this.snapshot(project, stages, envelopes)).states[index]!
    const latest = before.status === 'awaiting-checkpoint' ? before.latest : null
    let cleared = false
    if (latest) {
      await assertAwaitedWorkSettled(this.deps, { project, stage: stages[index]!, state: before })
      // The person's settlement, written as a revision that counts only once the claim below
      // names it: an acceptance that loses the claim leaves the accepted result untouched.
      const acceptedOutcomeId = await settleStageRevision(this.deps, {
        homeWorkspaceId,
        project,
        stage: stages[index]!,
        state: before,
        envelopes,
        revision,
        decidedBy: userId,
      })
      // The result is on record, so its task has recorded: say so first, in case the write that
      // freed its stage never landed and the acceptance below would find nothing to accept.
      const now = this.deps.clock.now()
      await this.deps.records.markStageTaskRecorded(projectId, latest.taskId, now)
      cleared = await this.deps.records.clearStageCheckpoint(
        projectId,
        latest.taskId,
        now,
        userId,
        acceptedOutcomeId,
      )
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
    return {
      stages,
      tasks: new Map(tasks.map((t) => [t.id, t] as const)),
      states,
      stageTasks,
      liveTaskIds,
      outcomes,
    }
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

/** Each stage without its handler config, with its state. */
function viewsOf(
  stages: readonly ProjectStage[],
  states: readonly ProjectStageState[],
): ProjectStageView[] {
  return stages.map((stage, i) => {
    const { config: _config, ...shown } = stage
    return { stage: shown, state: states[i]! }
  })
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
