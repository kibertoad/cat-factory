import type { Block, SourceTask, TaskRecord, TaskSourceKind } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { BoardWritePort } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import { toSourceTask } from './TaskImportService.js'

// TaskLinkService: the write side that attaches an imported issue to the board.
// `linkToBlock` records the link so the execution engine feeds the issue to
// agents as extra context; `createTaskFromIssue` goes one step further and
// materialises the issue as a brand-new board task (seeded from the issue), then
// links the issue to it — the inbound analogue of the document integration's
// spawn. Source-agnostic: it works on the projected task records.

export interface TaskLinkServiceDependencies {
  boardService: BoardWritePort
  blockRepository: BlockRepository
  taskRepository: TaskRepository
}

/** A board task created from an imported issue, plus the now-linked issue. */
export interface TaskFromIssue {
  block: Block
  task: SourceTask
}

export class TaskLinkService {
  constructor(private readonly deps: TaskLinkServiceDependencies) {}

  /** Attach an imported issue to a board block as extra agent context. */
  async linkToBlock(
    workspaceId: string,
    blockId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<SourceTask> {
    const block: Block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const task = assertFound(
      await this.deps.taskRepository.get(workspaceId, source, externalId),
      'Task',
      externalId,
    )
    await this.deps.taskRepository.linkBlock(workspaceId, source, externalId, block.id)
    return toSourceTask({ ...task, linkedBlockId: block.id })
  }

  /**
   * Create a new board task from an already-imported issue, inside a container
   * (service frame or module), and link the issue to the new task for context.
   * The title/description are seeded from the issue; the issue stays the source
   * of truth (re-importing refreshes it) and is fed to every agent step via the
   * link. Reuses BoardService.addTask so scope/placement rules stay in one place.
   */
  async createTaskFromIssue(
    workspaceId: string,
    containerId: string,
    source: TaskSourceKind,
    externalId: string,
  ): Promise<TaskFromIssue> {
    const issue = assertFound(
      await this.deps.taskRepository.get(workspaceId, source, externalId),
      'Task',
      externalId,
    )
    const block = await this.deps.boardService.addTask(workspaceId, containerId, {
      title: issueTaskTitle(issue),
      description: issueTaskDescription(issue),
    })
    // Link the issue to the new task so agents get the full issue (description,
    // comments, metadata) as context — and the task carries the back-reference.
    await this.deps.taskRepository.linkBlock(workspaceId, source, externalId, block.id)
    return { block, task: toSourceTask({ ...issue, linkedBlockId: block.id }) }
  }
}

/** Seed the new task's title from the issue (keyed for traceability). */
function issueTaskTitle(issue: TaskRecord): string {
  return `${issue.externalId}: ${issue.title}`
}

/** Seed the new task's description: a source reference line + the issue body. */
function issueTaskDescription(issue: TaskRecord): string {
  const reference = `Imported from ${issue.url}`
  const body = issue.description.trim() || issue.excerpt.trim()
  return body ? `${reference}\n\n${body}` : reference
}
