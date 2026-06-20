import type {
  AddFrameInput,
  AddModuleInput,
  AddServiceFromRepoInput,
  AddTaskInput,
  ReparentInput,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Block, BlockType, Position } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import { BLOCK_TYPE_LABEL } from '@cat-factory/kernel'
import type {
  BlockRepository,
  Clock,
  ExecutionRepository,
  RepoProjectionRepository,
  Service,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { requireWorkspace } from '@cat-factory/kernel'
import { canReparent, descendantIds, gridSlot, serviceOf, tasksOf } from './board.logic.js'

export interface BoardServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * The GitHub repo projection, present only when the GitHub integration is
   * wired. Backs {@link BoardService.addServiceFromRepo}, which links an existing
   * repo to the new service frame; absent → that path reports unavailable.
   */
  repoProjectionRepository?: RepoProjectionRepository
  /**
   * In-org shared services. When wired, every new top-level frame is registered as
   * an account-owned {@link Service} and mounted onto the creating workspace, so it
   * can be shared with other workspaces in the same org. Absent → frames are plain
   * workspace-local blocks (legacy behaviour).
   */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
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
  private readonly clock: Clock
  private readonly repoProjectionRepository?: RepoProjectionRepository
  private readonly serviceRepository?: ServiceRepository
  private readonly workspaceMountRepository?: WorkspaceMountRepository

  constructor({
    workspaceRepository,
    blockRepository,
    executionRepository,
    idGenerator,
    clock,
    repoProjectionRepository,
    serviceRepository,
    workspaceMountRepository,
  }: BoardServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.repoProjectionRepository = repoProjectionRepository
    this.serviceRepository = serviceRepository
    this.workspaceMountRepository = workspaceMountRepository
  }

  /**
   * Register a newly created top-level frame as an account-owned service and mount it
   * onto the creating workspace (in-org sharing). Returns the new service id so the
   * frame block can be stamped with it (the block is `listByService`-discoverable on
   * every workspace that mounts the service). The frame's board position is carried on
   * the mount (the per-workspace layout override). No-op (returns undefined) when the
   * service repositories aren't wired.
   */
  private async registerService(
    workspaceId: string,
    frame: Block,
    repo?: { installationId: number; githubId: number },
  ): Promise<string | undefined> {
    if (!this.serviceRepository || !this.workspaceMountRepository) return undefined
    const accountId = (await this.workspaceRepository.accountOf(workspaceId)) ?? null
    const now = this.clock.now()
    const service: Service = {
      id: this.idGenerator.next('svc'),
      accountId,
      frameBlockId: frame.id,
      installationId: repo?.installationId ?? null,
      repoGithubId: repo?.githubId ?? null,
      createdAt: now,
    }
    await this.serviceRepository.insert(service)
    await this.workspaceMountRepository.upsert({
      workspaceId,
      serviceId: service.id,
      position: frame.position,
      size: frame.size ?? null,
      createdAt: now,
    })
    return service.id
  }

  /**
   * The service id a block being added under `container` belongs to: the service of the
   * container's enclosing frame. Undefined when the service repos aren't wired or the
   * frame isn't a registered service (legacy/seeded frame) — the block is then plain
   * workspace-local.
   */
  private async serviceForContainer(
    blocks: Block[],
    container: Block,
  ): Promise<string | undefined> {
    if (!this.serviceRepository) return undefined
    const frame = container.level === 'frame' ? container : serviceOf(blocks, container)
    if (!frame) return undefined
    return (await this.serviceRepository.getByFrameBlock(frame.id))?.id
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
    const serviceId = await this.registerService(workspaceId, block)
    await this.blockRepository.insert(workspaceId, block, serviceId)
    return block
  }

  /**
   * Add a service frame backed by an existing GitHub repo the workspace already
   * links (the App is installed and the repo is projected). No container / agent
   * run — the frame is created `ready`, titled after the repo, and the repo
   * projection row is linked to it so execution resolves this repo for tasks
   * dropped on the frame. The frontend's drag-drop path uses {@link addFrame};
   * this is the "import an existing repo as a service" button.
   */
  async addServiceFromRepo(workspaceId: string, input: AddServiceFromRepoInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    if (!this.repoProjectionRepository) {
      throw new ValidationError('GitHub integration is not configured')
    }
    const repo = assertFound(
      await this.repoProjectionRepository.get(workspaceId, input.repoGithubId),
      'GitHubRepo',
      String(input.repoGithubId),
    )
    if (repo.blockId) {
      throw new ValidationError('This repository is already linked to a board service')
    }
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const frames = blocks.filter((b) => b.level === 'frame').length
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title: repo.name,
      type: 'service',
      description: `Service backed by ${repo.owner}/${repo.name}.`,
      position: input.position ?? { x: 80 + (frames % 5) * 48, y: 80 + (frames % 5) * 48 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
    }
    const serviceId = await this.registerService(workspaceId, block, {
      installationId: repo.installationId,
      githubId: repo.githubId,
    })
    await this.blockRepository.insert(workspaceId, block, serviceId)
    await this.repoProjectionRepository.linkBlock(workspaceId, repo.githubId, block.id)
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
    }
    // Optional run configuration chosen at creation: which merge policy governs the
    // task's auto-merge, and the pipeline its Run controls default to. Empty strings
    // are treated as "not set" (workspace default preset / no pinned pipeline).
    if (input.mergePresetId) block.mergePresetId = input.mergePresetId
    if (input.pipelineId) block.pipelineId = input.pipelineId
    await this.blockRepository.insert(
      workspaceId,
      block,
      await this.serviceForContainer(blocks, container),
    )
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
    await this.blockRepository.insert(
      workspaceId,
      block,
      await this.serviceForContainer(blocks, service),
    )
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
    // Unlink any repo backing a doomed service frame so the repo becomes
    // addable again (otherwise its github_repos.block_id dangles to a deleted
    // block: the repo shows "already on board" yet nothing renders it).
    if (this.repoProjectionRepository) {
      const repos = await this.repoProjectionRepository.list(workspaceId)
      for (const repo of repos) {
        if (repo.blockId && doomed.has(repo.blockId)) {
          await this.repoProjectionRepository.linkBlock(workspaceId, repo.githubId, null)
        }
      }
    }
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
