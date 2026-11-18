import {
  type Project,
  type SpawnRecord,
  type SpawnedTask,
  SPAWN_TASK_TYPE,
  UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
  parseSpawnStageConfig,
  spawnTextFor,
} from '@cat-factory/contracts'
import {
  type Block,
  type BlockRepository,
  type Logger,
  type ServiceRepository,
  getErrorMessage,
  noopLogger,
} from '@cat-factory/kernel'
import { type SpawnedTaskLinks, rollbackSpawnedTask } from '../spawn/spawnedTask.js'
import type { StageRunStarter, StageTaskBoard } from './ProjectStageService.js'

// A spawn stage's run, which the engine performs itself: one ordinary task in each service the
// project links, the project linked to it so it reads the stages' accepted results, and its run
// started. Every created task's id is derived from the stage task and the service, so a replayed
// run finds the tasks it already made instead of making them twice. A service it cannot put a
// task into is recorded as skipped with the reason, never left out. Design:
// `docs/initiatives/staged-project-definitions.md`.

/** What a task the engine performs, rather than an agent, is given when its step runs. */
export interface ProjectEngineTaskInput {
  /** The workspace that homes the project and its stage task. */
  workspaceId: string
  project: Project
  /** The stage task whose run this is. */
  task: Block
  /** The plan its handler fixed on the step. */
  plan: unknown
}

/** A project task type the engine performs itself, keyed by task type. */
export interface ProjectEngineTask {
  taskType: string
  /** The reply the step records, as its handler's `finish` reads it. */
  run(input: ProjectEngineTaskInput): Promise<unknown>
}

export interface StageSpawnerDeps {
  serviceRepository: Pick<ServiceRepository, 'listByIds'>
  blockRepository: Pick<BlockRepository, 'findByIds' | 'getMany'>
  /** Late-bound: the board is built after the projects module. */
  board: () => StageTaskBoard | undefined
  /** Late-bound: the engine is built after the projects module. */
  runStarter: () => StageRunStarter | undefined
  links?: SpawnedTaskLinks
  logger?: Logger
}

/** The id of the task a spawn stage's task creates in one service. */
export function spawnedTaskId(stageTaskId: string, serviceId: string): string {
  return `${stageTaskId}_${serviceId}`
}

/** A service the stage puts a task into: its frame, and the task a replay already made. */
interface SpawnTarget {
  serviceId: string
  serviceName: string
  /** The board that homes the service's frame, and so the task. */
  home: string
  frameId: string
  taskId: string
  made: Block | undefined
}

export function stageSpawner(deps: StageSpawnerDeps): ProjectEngineTask {
  const log = deps.logger ?? noopLogger
  return {
    taskType: SPAWN_TASK_TYPE,
    async run({ project, task, plan }): Promise<SpawnRecord> {
      const config = parseSpawnStageConfig(plan)
      if (!config.ok) throw new Error(`The spawn plan is unreadable: ${config.issues.join('; ')}`)
      const board = deps.board()
      const runs = deps.runStarter()
      if (!board || !runs) throw new Error('The board or engine is not wired, so nothing can spawn')
      const record: SpawnRecord = { tasks: [], skipped: [] }
      const targets = await targetsOf(deps, project, task.id, record)

      // Create what a replay did not make yet. Nothing was written when `addTask` refuses.
      const created: { target: SpawnTarget; block: Block }[] = []
      for (const target of targets) {
        if (target.made) {
          created.push({ target, block: target.made })
          continue
        }
        try {
          const block = await board.addTask(
            target.home,
            target.frameId,
            {
              title: spawnTextFor(config.value.title, target.serviceName),
              description: spawnTextFor(config.value.description, target.serviceName),
              taskType: config.value.taskType,
              ...(config.value.pipelineId ? { pipelineId: config.value.pipelineId } : {}),
            },
            // No person authors a spawned task, so no tier narrows its merge policy.
            UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
            null,
            { id: target.taskId },
          )
          created.push({ target, block })
        } catch (error) {
          record.skipped.push(skip(target, errorText(error)))
        }
      }

      // One admission for every task: the link reads the stages a person accepted.
      const linkFailure = await linkAll(deps, project.id, created)
      for (const { target, block } of created) {
        const entry = {
          serviceId: target.serviceId,
          serviceName: target.serviceName,
          workspaceId: target.home,
          taskId: target.taskId,
          title: block.title,
        }
        if (linkFailure === null) {
          record.tasks.push(await startSpawned(runs, target.home, block, entry))
        } else if (target.made) {
          // Made by an earlier attempt: it stays on its board and the checkpoint waits on it.
          record.tasks.push({ ...entry, started: !!block.executionId, note: linkFailure })
        } else {
          await rollbackSpawnedTask(
            {
              ...(deps.links ? { links: deps.links } : {}),
              removeTask: (ws, blockId) => board.removeTask(ws, blockId),
              log,
            },
            'projects.spawn.rollbackTask',
            target.home,
            target.taskId,
            { projectId: project.id, serviceId: target.serviceId },
          )
          record.skipped.push(skip(target, linkFailure))
        }
      }
      return record
    },
  }
}

/**
 * The services the stage puts a task into, in the project's order. One it cannot use (gone, no
 * frame, an archived frame no board shows) is recorded as skipped with the reason.
 */
async function targetsOf(
  deps: StageSpawnerDeps,
  project: Project,
  stageTaskId: string,
  record: SpawnRecord,
): Promise<SpawnTarget[]> {
  const services = new Map(
    (await deps.serviceRepository.listByIds(project.serviceIds)).map((s) => [s.id, s] as const),
  )
  // Keyed by the service that owns the frame: a block id alone does not name one board.
  const frames = new Map(
    (await deps.blockRepository.findByIds([...services.values()].map((s) => s.frameBlockId)))
      .filter((f) => f.ownerId !== null && services.get(f.ownerId)?.frameBlockId === f.block.id)
      .map((f) => [f.ownerId!, f] as const),
  )
  const existing = await tasksAlreadySpawned(deps, stageTaskId, services, frames)
  const targets: SpawnTarget[] = []
  for (const serviceId of project.serviceIds) {
    const frame = frames.get(serviceId)
    if (!frame || frame.block.archived) {
      const reason = !services.has(serviceId)
        ? 'The service is gone.'
        : frame
          ? 'The service is archived.'
          : 'The service has no frame on any board.'
      record.skipped.push({ serviceId, serviceName: frame?.block.title ?? null, reason })
      continue
    }
    const taskId = spawnedTaskId(stageTaskId, serviceId)
    targets.push({
      serviceId,
      // A service is named by its frame on the board.
      serviceName: frame.block.title,
      home: frame.workspaceId,
      frameId: frame.block.id,
      taskId,
      made: existing.get(taskId),
    })
  }
  return targets
}

/** Link the project to every task, admitted once; the reason when it cannot be, else null. */
async function linkAll(
  deps: StageSpawnerDeps,
  projectId: string,
  created: readonly { target: SpawnTarget }[],
): Promise<string | null> {
  if (created.length === 0) return null
  if (!deps.links) return 'Linking projects is not configured, so the task cannot read the project.'
  try {
    await deps.links.linkMany(
      created.map(({ target }) => ({ workspaceId: target.home, blockId: target.taskId })),
      [projectId],
    )
    return null
  } catch (error) {
    return errorText(error)
  }
}

function skip(target: SpawnTarget, reason: string): SpawnRecord['skipped'][number] {
  return { serviceId: target.serviceId, serviceName: target.serviceName, reason }
}

/**
 * The tasks a replayed run already created, by id. Asked of each board the services' frames live
 * on, since a by-id read cannot ask after an id that may not exist yet on a mothership node.
 */
async function tasksAlreadySpawned(
  deps: StageSpawnerDeps,
  stageTaskId: string,
  services: ReadonlyMap<string, { id: string; frameBlockId: string }>,
  frames: ReadonlyMap<string, { workspaceId: string }>,
): Promise<Map<string, Block>> {
  const byWorkspace = new Map<string, string[]>()
  for (const service of services.values()) {
    const home = frames.get(service.id)?.workspaceId
    if (!home) continue
    byWorkspace.set(home, [
      ...(byWorkspace.get(home) ?? []),
      spawnedTaskId(stageTaskId, service.id),
    ])
  }
  const found = await Promise.all(
    [...byWorkspace].map(([workspaceId, ids]) => deps.blockRepository.getMany(workspaceId, ids)),
  )
  return new Map(found.flat().map((block) => [block.id, block] as const))
}

/** Start a spawned task's run, or say why it waits on its board for a person. */
async function startSpawned(
  runs: StageRunStarter,
  homeWorkspaceId: string,
  block: Block,
  task: Omit<SpawnedTask, 'started' | 'note'>,
): Promise<SpawnedTask> {
  if (block.executionId) return { ...task, started: true }
  // The task pins the stage's pipeline, or its type's default, so a person restarting it runs the
  // same one.
  const pipelineId = block.pipelineId
  if (!pipelineId) {
    return { ...task, started: false, note: 'Its task type pins no pipeline; a person starts it.' }
  }
  try {
    // A personal subscription is leased by the person who starts a run, and nobody starts this one.
    const [vendor] = await runs.individualVendorsForBlock(homeWorkspaceId, block.id, pipelineId)
    if (vendor) {
      return {
        ...task,
        started: false,
        note: `It runs on an individual-usage ${vendor} model, so a person starts it.`,
      }
    }
    await runs.start(homeWorkspaceId, block.id, pipelineId)
    return { ...task, started: true }
  } catch (error) {
    return { ...task, started: false, note: errorText(error) }
  }
}

function errorText(error: unknown): string {
  return getErrorMessage(error).slice(0, 2000)
}
