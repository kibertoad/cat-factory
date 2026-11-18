import { type Logger, ValidationError, runBestEffort } from '@cat-factory/kernel'
import type { TaskProjectLinkService } from '../projects/TaskProjectLinkService.js'

// What every path that creates a task on the board's behalf and starts it does to the projects
// the task reads, shared by an initiative's spawned items and a project's spawn stage.

export type SpawnedTaskLinks = Pick<TaskProjectLinkService, 'link' | 'unlinkAll'>

/**
 * Link the projects a spawned task reads, under the rules a link made on the board meets.
 * Refuses when it names projects and linking is not wired, so the task is never started without
 * the context it was created to read.
 */
export async function linkSpawnedTask(
  links: SpawnedTaskLinks | undefined,
  workspaceId: string,
  blockId: string,
  projectIds: readonly string[] | undefined,
): Promise<void> {
  if (!projectIds?.length) return
  if (!links) {
    throw new ValidationError('This task links projects, and linking projects is not configured')
  }
  await links.link(workspaceId, blockId, [...projectIds])
}

/**
 * Undo a spawned task that could not go on: its project links, then the task. Best-effort: a
 * failed rollback leaves a task with no run on the board, so the log names the cause a person
 * needs.
 */
export async function rollbackSpawnedTask(
  deps: {
    links?: SpawnedTaskLinks
    removeTask: (workspaceId: string, blockId: string) => Promise<void>
    log: Logger
  },
  label: string,
  workspaceId: string,
  blockId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await runBestEffort(
    deps.log,
    label,
    async () => {
      await deps.links?.unlinkAll(workspaceId, blockId)
      await deps.removeTask(workspaceId, blockId)
    },
    { workspaceId, blockId, ...fields },
  )
}
