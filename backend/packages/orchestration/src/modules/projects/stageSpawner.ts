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
import {
  type SpawnedTaskLinks,
  linkSpawnedTask,
  rollbackSpawnedTask,
} from '../spawn/spawnedTask.js'
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
      const services = new Map(
        (await deps.serviceRepository.listByIds(project.serviceIds)).map((s) => [s.id, s] as const),
      )
      // Keyed by the service that owns the frame: a block id alone does not name one board.
      const frames = new Map(
        (await deps.blockRepository.findByIds([...services.values()].map((s) => s.frameBlockId)))
          .filter((f) => f.ownerId !== null && services.get(f.ownerId)?.frameBlockId === f.block.id)
          .map((f) => [f.ownerId!, f] as const),
      )
      const existing = await tasksAlreadySpawned(deps, task.id, services, frames)
      const record: SpawnRecord = { tasks: [], skipped: [] }
      for (const serviceId of project.serviceIds) {
        const service = services.get(serviceId)
        const frame = frames.get(serviceId)
        if (!frame) {
          record.skipped.push({
            serviceId,
            serviceName: null,
            reason: service ? 'The service has no frame on any board.' : 'The service is gone.',
          })
          continue
        }
        // A service is named by its frame on the board.
        const serviceName = frame.block.title
        const id = spawnedTaskId(task.id, serviceId)
        const made = existing.get(id)
        // A task is created on the board that homes its service's frame.
        const home = frame.workspaceId
        const title = spawnTextFor(config.value.title, serviceName)
        let block: Block
        try {
          block =
            made ??
            (await board.addTask(
              frame.workspaceId,
              frame.block.id,
              {
                title,
                description: spawnTextFor(config.value.description, serviceName),
                taskType: config.value.taskType,
              },
              // No person authors a spawned task, so no tier narrows its merge policy.
              UNATTRIBUTED_BLOCK_EDIT_AUTHORITY,
              null,
              { id },
            ))
          await linkSpawnedTask(deps.links, home, id, [project.id])
        } catch (error) {
          if (!made) {
            await rollbackSpawnedTask(
              {
                ...(deps.links ? { links: deps.links } : {}),
                removeTask: (ws, blockId) => board.removeTask(ws, blockId),
                log,
              },
              'projects.spawn.rollbackTask',
              home,
              id,
              { projectId: project.id, serviceId },
            )
          }
          record.skipped.push({ serviceId, serviceName, reason: errorText(error) })
          continue
        }
        record.tasks.push(
          await startSpawned(runs, home, block, config.value.pipelineId, {
            serviceId,
            serviceName,
            workspaceId: home,
            taskId: id,
            title: block.title,
          }),
        )
      }
      return record
    },
  }
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
  pipelineOverride: string | undefined,
  task: Omit<SpawnedTask, 'started' | 'note'>,
): Promise<SpawnedTask> {
  if (block.executionId) return { ...task, started: true }
  const pipelineId = pipelineOverride ?? block.pipelineId
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
