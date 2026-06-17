import type {
  AddFrameInput,
  AddModuleInput,
  AddTaskInput,
  ReparentInput,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Block, BlockType, Position } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import { BLOCK_TYPE_LABEL, DEFAULT_CONFIDENCE_THRESHOLD } from '@cat-factory/kernel'
import type { BlockRepository, ExecutionRepository, WorkspaceRepository } from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { canReparent, descendantIds, gridSlot, serviceOf, tasksOf } from './board.logic'

export interface BoardServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
}

/**
 * Board mutations: frames, modules, tasks and the dependency edges between them.
 * Mirrors the operations the frontend's board store performs locally, but
 * against the persistence ports. Each method loads only what it needs, applies
 * the pure board logic, then writes back.
 */
export class BoardService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator

  constructor({
    workspaceRepository,
    blockRepository,
    executionRepository,
    idGenerator,
  }: BoardServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
  }

  private requireWorkspace(workspaceId: string) {
    return requireWorkspace(this.workspaceRepository, workspaceId)
  }

  private async requireBlock(workspaceId: string, id: string): Promise<Block> {
    return assertFound(await this.blockRepository.get(workspaceId, id), 'Block', id)
  }

  /** Add a top-level frame (service/api/database/…) to the board. */
  async addFrame(workspaceId: string, input: AddFrameInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const type = input.type as BlockType
    const count = blocks.filter((b) => b.type === type).length + 1
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title: `${BLOCK_TYPE_LABEL[type]} ${count}`,
      type,
      description: 'Newly dropped building block. Drag a pipeline onto it to start.',
      position: input.position,
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
    await this.blockRepository.insert(workspaceId, block)
    return block
  }

  /** Add a task inside a container (a service frame or a module). */
  async addTask(workspaceId: string, containerId: string, input: AddTaskInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const container = await this.requireBlock(workspaceId, containerId)
    if (container.level === 'task') {
      throw new ValidationError('Tasks cannot contain other tasks')
    }
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const siblings = tasksOf(blocks, containerId).length
    const service = serviceOf(blocks, container)
    const block: Block = {
      id: this.idGenerator.next('task'),
      title: input.title.trim(),
      type: service?.type ?? container.type,
      description: input.description?.trim() ?? '',
      position: gridSlot(siblings),
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'task',
      parentId: containerId,
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
      features: [],
    }
    await this.blockRepository.insert(workspaceId, block)
    return block
  }

  /** Add a module (sub-frame) inside a service. */
  async addModule(workspaceId: string, serviceId: string, input: AddModuleInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const service = await this.requireBlock(workspaceId, serviceId)
    if (service.level !== 'frame') {
      throw new ValidationError('Modules can only be added to a service frame')
    }
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const n = blocks.filter((b) => b.parentId === serviceId && b.level === 'module').length
    const block: Block = {
      id: this.idGenerator.next('mod'),
      title: input.name,
      type: service.type,
      description: `Module within ${service.title}.`,
      position: input.position ?? gridSlot(n, 2, 280, 220, 24, 80),
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'module',
      parentId: serviceId,
    }
    await this.blockRepository.insert(workspaceId, block)
    return block
  }

  async moveBlock(workspaceId: string, id: string, position: Position): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, id)
    await this.blockRepository.update(workspaceId, id, { position })
    return this.requireBlock(workspaceId, id)
  }

  async updateBlock(workspaceId: string, id: string, patch: UpdateBlockInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, id)
    await this.blockRepository.update(workspaceId, id, patch)
    return this.requireBlock(workspaceId, id)
  }

  /** Move a block into a new container at a new local position. */
  async reparent(workspaceId: string, id: string, input: ReparentInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const block = await this.requireBlock(workspaceId, id)
    if (id === input.parentId) throw new ValidationError('A block cannot contain itself')
    const parent = await this.requireBlock(workspaceId, input.parentId)
    if (!canReparent(block.level, parent)) {
      throw new ValidationError(`A ${block.level} cannot be placed inside a ${parent.level}`)
    }
    await this.blockRepository.update(workspaceId, id, {
      parentId: input.parentId,
      position: input.position,
    })
    return this.requireBlock(workspaceId, id)
  }

  /** Delete a block and all its descendants, dropping dangling dependencies. */
  async removeBlock(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    await this.requireBlock(workspaceId, id)
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const doomed = descendantIds(blocks, id)

    await this.executionRepository.deleteByBlock(workspaceId, id)
    await this.blockRepository.deleteMany(workspaceId, [...doomed])

    for (const b of blocks) {
      if (doomed.has(b.id)) continue
      const next = b.dependsOn.filter((d) => !doomed.has(d))
      if (next.length !== b.dependsOn.length) {
        await this.blockRepository.update(workspaceId, b.id, { dependsOn: next })
      }
    }
  }

  /** Toggle a dependency edge: target dependsOn source. */
  async toggleDependency(workspaceId: string, targetId: string, sourceId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    if (targetId === sourceId) {
      throw new ValidationError('A block cannot depend on itself')
    }
    const target = await this.requireBlock(workspaceId, targetId)
    await this.requireBlock(workspaceId, sourceId)
    const i = target.dependsOn.indexOf(sourceId)
    const next =
      i >= 0 ? target.dependsOn.filter((d) => d !== sourceId) : [...target.dependsOn, sourceId]
    await this.blockRepository.update(workspaceId, targetId, { dependsOn: next })
    return this.requireBlock(workspaceId, targetId)
  }
}
