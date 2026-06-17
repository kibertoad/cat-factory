import type { Block, SourceTask, TaskSourceKind } from '@cat-factory/kernel'
import { assertFound } from '@cat-factory/kernel'
import type { BlockRepository } from '@cat-factory/kernel'
import type { TaskRepository } from '@cat-factory/kernel'
import { toSourceTask } from './TaskImportService'

// TaskLinkService: the write side that attaches an imported issue to the board.
// `linkToBlock` records the link so the execution engine feeds the issue to
// agents as extra context. Unlike the document integration there is no spawn —
// an issue is linked for context, never expanded into board structure — so this
// service only needs the block + task repositories. Source-agnostic: it works on
// the projected task records.

export interface TaskLinkServiceDependencies {
  blockRepository: BlockRepository
  taskRepository: TaskRepository
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
}
