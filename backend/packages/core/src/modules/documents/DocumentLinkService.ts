import type {
  Block,
  DocumentBoardPlan,
  SourceDocument,
  DocumentSourceKind,
  PlanFrame,
} from '../../domain/types'
import { assertFound, ValidationError } from '../../domain/errors'
import type { BlockRepository } from '../../ports/repositories'
import type { DocumentRepository } from '../../ports/document-repositories'
import type { BoardService } from '../board/BoardService'
import { toSourceDocument } from './DocumentImportService'

// DocumentLinkService: the write side that connects an imported document to the
// board. `spawn` materialises a planned structure into real frames, modules and
// tasks via the existing BoardService operations; `linkToBlock` attaches an
// imported document to a block so the execution engine feeds it to agents as
// extra context. Source-agnostic — it works on the projected document records.

export interface DocumentLinkServiceDependencies {
  boardService: BoardService
  blockRepository: BlockRepository
  documentRepository: DocumentRepository
}

/** Counts of blocks created by a spawn, for the API response. */
export interface SpawnResult {
  frames: number
  modules: number
  tasks: number
}

export class DocumentLinkService {
  constructor(private readonly deps: DocumentLinkServiceDependencies) {}

  /**
   * Apply a board plan to a workspace. Without `frameId` each planned frame
   * becomes a new top-level frame; with it, the plan's modules and tasks are
   * added inside that existing frame (the planned frames are flattened into it).
   */
  async spawn(
    workspaceId: string,
    plan: DocumentBoardPlan,
    frameId?: string,
  ): Promise<SpawnResult> {
    const result: SpawnResult = { frames: 0, modules: 0, tasks: 0 }

    if (frameId) {
      const target = assertFound(
        await this.deps.blockRepository.get(workspaceId, frameId),
        'Block',
        frameId,
      )
      if (target.level !== 'frame') {
        throw new ValidationError('Document structure can only be spawned into a service frame')
      }
      for (const frame of plan.frames) {
        await this.spawnInto(workspaceId, target.id, frame, result)
      }
      return result
    }

    let column = 0
    for (const frame of plan.frames) {
      const created = await this.deps.boardService.addFrame(workspaceId, {
        type: frame.type,
        position: { x: 80 + column * 380, y: 80 },
      })
      column += 1
      result.frames += 1
      await this.deps.boardService.updateBlock(workspaceId, created.id, {
        title: frame.title,
        ...(frame.description ? { description: frame.description } : {}),
      })
      await this.spawnInto(workspaceId, created.id, frame, result)
    }
    return result
  }

  /** Add a planned frame's modules and tasks inside an existing frame. */
  private async spawnInto(
    workspaceId: string,
    frameId: string,
    frame: PlanFrame,
    result: SpawnResult,
  ): Promise<void> {
    for (const task of frame.tasks) {
      await this.addTask(workspaceId, frameId, task, result)
    }
    for (const planModule of frame.modules) {
      const module = await this.deps.boardService.addModule(workspaceId, frameId, {
        name: planModule.name,
      })
      result.modules += 1
      for (const task of planModule.tasks) {
        await this.addTask(workspaceId, module.id, task, result)
      }
    }
  }

  private async addTask(
    workspaceId: string,
    containerId: string,
    task: { title: string; description?: string; features?: string[] },
    result: SpawnResult,
  ): Promise<void> {
    const created = await this.deps.boardService.addTask(workspaceId, containerId, {
      title: task.title,
    })
    result.tasks += 1
    const patch: { description?: string; features?: string[] } = {}
    if (task.description) patch.description = task.description
    if (task.features?.length) patch.features = task.features
    if (Object.keys(patch).length > 0) {
      await this.deps.boardService.updateBlock(workspaceId, created.id, patch)
    }
  }

  /** Attach an imported document to a board block as extra agent context. */
  async linkToBlock(
    workspaceId: string,
    blockId: string,
    source: DocumentSourceKind,
    externalId: string,
  ): Promise<SourceDocument> {
    const block: Block = assertFound(
      await this.deps.blockRepository.get(workspaceId, blockId),
      'Block',
      blockId,
    )
    const document = assertFound(
      await this.deps.documentRepository.get(workspaceId, source, externalId),
      'Document',
      externalId,
    )
    await this.deps.documentRepository.linkBlock(workspaceId, source, externalId, block.id)
    return toSourceDocument({ ...document, linkedBlockId: block.id })
  }
}
