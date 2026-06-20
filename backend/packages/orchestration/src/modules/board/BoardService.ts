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
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { registerServiceForFrame, requireWorkspace } from '@cat-factory/kernel'
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
  private registerService(
    workspaceId: string,
    frame: Block,
    repo?: { installationId: number; githubId: number; directory?: string | null },
  ): Promise<string | undefined> {
    return registerServiceForFrame(
      {
        serviceRepository: this.serviceRepository,
        workspaceMountRepository: this.workspaceMountRepository,
        workspaceRepository: this.workspaceRepository,
        idGenerator: this.idGenerator,
        clock: this.clock,
      },
      workspaceId,
      frame,
      repo,
    )
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

  /**
   * Resolve a block the requesting workspace is allowed to mutate, returning the block plus
   * the workspace that physically homes it. A block created locally resolves to this
   * workspace; a block belonging to a service this workspace MOUNTS (in-org sharing) resolves
   * to the service's home workspace, so a shared board is fully interactive — edits, moves,
   * adds and deletes act on the one shared copy. Throws NotFound when the workspace neither
   * homes the block nor mounts its service (or sharing isn't wired and it isn't local).
   */
  private async resolveBlock(
    workspaceId: string,
    id: string,
  ): Promise<{ homeWorkspaceId: string; block: Block }> {
    const local = await this.blockRepository.get(workspaceId, id)
    if (local) return { homeWorkspaceId: workspaceId, block: local }
    if (this.serviceRepository && this.workspaceMountRepository) {
      const found = await this.blockRepository.findById(id)
      if (
        found?.serviceId &&
        (await this.workspaceMountRepository.get(workspaceId, found.serviceId))
      ) {
        return { homeWorkspaceId: found.workspaceId, block: found.block }
      }
    }
    return assertFound<{ homeWorkspaceId: string; block: Block }>(null, 'Block', id)
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
    // Normalise the requested service subdirectory to a clean relative path.
    const directory = input.directory?.trim().replace(/^\/+|\/+$/g, '') || undefined
    // A monorepo can back SEVERAL service frames (one per subdirectory), so the
    // single-service guard applies only to whole-repo (non-monorepo) repos. A monorepo
    // service MUST name its subdirectory so execution can scope agents to it.
    if (repo.blockId && !repo.isMonorepo) {
      throw new ValidationError('This repository is already linked to a board service')
    }
    if (repo.isMonorepo && !directory) {
      throw new ValidationError('Select a service directory for this monorepo')
    }
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const frames = blocks.filter((b) => b.level === 'frame').length
    const title = directory ? (directory.split('/').pop() ?? repo.name) : repo.name
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title,
      type: 'service',
      description: directory
        ? `Service backed by ${repo.owner}/${repo.name} (${directory}/).`
        : `Service backed by ${repo.owner}/${repo.name}.`,
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
      directory: directory ?? null,
    })
    await this.blockRepository.insert(workspaceId, block, serviceId)
    // A monorepo's repo backs several frames, so the projection's single `block_id`
    // link can't represent it — the Service mapping (read by resolveRepoTarget) is
    // authoritative there. Keep the legacy link only for a whole-repo service.
    if (!repo.isMonorepo) {
      await this.repoProjectionRepository.linkBlock(workspaceId, repo.githubId, block.id)
    }
    return block
  }

  /** Add a task inside a container (a service frame or a module). */
  async addTask(workspaceId: string, containerId: string, input: AddTaskInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    // The container may be a frame/module of a service mounted from another workspace; create
    // the task in that service's home workspace so it joins the one shared subtree.
    const { homeWorkspaceId, block: container } = await this.resolveBlock(workspaceId, containerId)
    if (container.level === 'task') {
      throw new ValidationError('Tasks cannot contain other tasks')
    }
    const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
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
      homeWorkspaceId,
      block,
      await this.serviceForContainer(blocks, container),
    )
    return block
  }

  /** Add a module (sub-frame) inside a service. */
  async addModule(workspaceId: string, serviceId: string, input: AddModuleInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    // The service frame may be mounted from another workspace; create the module in its home.
    const { homeWorkspaceId, block: service } = await this.resolveBlock(workspaceId, serviceId)
    if (service.level !== 'frame') {
      throw new ValidationError('Modules can only be added to a service frame')
    }
    const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
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
      homeWorkspaceId,
      block,
      await this.serviceForContainer(blocks, service),
    )
    return block
  }

  async moveBlock(workspaceId: string, id: string, position: Position): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await this.resolveBlock(workspaceId, id)
    // A service frame's board position is a PER-WORKSPACE layout override carried on the mount
    // (the snapshot renders frames from the mount, so the same shared frame can sit at a
    // different spot on each board). Write it onto THIS workspace's mount — for a home frame as
    // much as one mounted from elsewhere — and leave the shared block untouched.
    if (block.level === 'frame' && this.serviceRepository && this.workspaceMountRepository) {
      const service = await this.serviceRepository.getByFrameBlock(id)
      if (service && (await this.workspaceMountRepository.get(workspaceId, service.id))) {
        await this.workspaceMountRepository.update(workspaceId, service.id, { position })
        return { ...block, position }
      }
    }
    // A non-frame block, or a legacy frame with no mount: move the shared block at its home.
    await this.blockRepository.update(homeWorkspaceId, id, { position })
    return assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id)
  }

  async updateBlock(workspaceId: string, id: string, patch: UpdateBlockInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId } = await this.resolveBlock(workspaceId, id)
    await this.blockRepository.update(homeWorkspaceId, id, patch)
    return assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id)
  }

  /** Move a block into a new container at a new local position. */
  async reparent(workspaceId: string, id: string, input: ReparentInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId: blockHome, block } = await this.resolveBlock(workspaceId, id)
    if (id === input.parentId) throw new ValidationError('A block cannot contain itself')
    const { homeWorkspaceId: parentHome, block: parent } = await this.resolveBlock(
      workspaceId,
      input.parentId,
    )
    if (!canReparent(block.level, parent)) {
      throw new ValidationError(`A ${block.level} cannot be placed inside a ${parent.level}`)
    }

    // Same physical home (the common case, incl. two of the workspace's own services): move in
    // place and re-stamp `service_id`, the physical scope key that decides which boards render
    // the subtree and where its events fan out. No-op re-stamp when sharing isn't wired or the
    // destination frame isn't a registered service.
    if (blockHome === parentHome) {
      await this.blockRepository.update(blockHome, id, {
        parentId: input.parentId,
        position: input.position,
      })
      if (this.serviceRepository) {
        const blocks = await this.blockRepository.listByWorkspace(blockHome)
        const destService = await this.serviceForContainer(blocks, parent)
        await this.blockRepository.setService(
          blockHome,
          [...descendantIds(blocks, id)],
          destService ?? null,
        )
      }
      return assertFound(await this.blockRepository.get(blockHome, id), 'Block', id)
    }

    // Cross-home: the block and its new parent belong to two services homed in different
    // workspaces (both mounted on this board). Keep the invariant that a service's blocks live
    // in its home workspace by MOVING the subtree's rows — and any executions on them — to the
    // destination service's home, re-stamped with the destination service.
    const srcBlocks = await this.blockRepository.listByWorkspace(blockHome)
    const ids = [...descendantIds(srcBlocks, id)]
    const subtree = ids
      .map((bid) => srcBlocks.find((b) => b.id === bid))
      .filter((b): b is Block => b !== undefined)
    const parentBlocks = await this.blockRepository.listByWorkspace(parentHome)
    const destService = (await this.serviceForContainer(parentBlocks, parent)) ?? null
    for (const b of subtree) {
      const moved = b.id === id ? { ...b, parentId: input.parentId, position: input.position } : b
      await this.blockRepository.insert(parentHome, moved, destService)
      const exec = await this.executionRepository.getByBlock(blockHome, b.id)
      if (exec) {
        await this.executionRepository.deleteByBlock(blockHome, b.id)
        await this.executionRepository.upsert(parentHome, exec)
      }
    }
    await this.blockRepository.deleteMany(blockHome, ids)
    // Drop dependency edges in the source workspace that now dangle to the moved subtree.
    const moved = new Set(ids)
    for (const b of srcBlocks) {
      if (moved.has(b.id)) continue
      const next = b.dependsOn.filter((d) => !moved.has(d))
      if (next.length !== b.dependsOn.length) {
        await this.blockRepository.update(blockHome, b.id, { dependsOn: next })
      }
    }
    return assertFound(await this.blockRepository.get(parentHome, id), 'Block', id)
  }

  /** Delete a block and all its descendants, dropping dangling dependencies. */
  async removeBlock(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    // Resolve the block at its home so a shared service's block can be deleted from any board
    // that mounts it (the delete then applies to the one shared copy everywhere).
    const { homeWorkspaceId } = await this.resolveBlock(workspaceId, id)
    const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
    const doomed = descendantIds(blocks, id)

    await this.executionRepository.deleteByBlock(homeWorkspaceId, id)
    // Unlink any repo backing a doomed service frame so the repo becomes
    // addable again (otherwise its github_repos.block_id dangles to a deleted
    // block: the repo shows "already on board" yet nothing renders it).
    if (this.repoProjectionRepository) {
      const repos = await this.repoProjectionRepository.list(homeWorkspaceId)
      for (const repo of repos) {
        if (repo.blockId && doomed.has(repo.blockId)) {
          await this.repoProjectionRepository.linkBlock(homeWorkspaceId, repo.githubId, null)
        }
      }
    }
    // Drop the account-owned service (and every workspace's mount of it) for any doomed
    // service frame, so deleting a frame doesn't leave an orphaned service lingering in the
    // org catalog (mountable, badged, yet rendering nothing) on other boards.
    if (this.serviceRepository && this.workspaceMountRepository) {
      const doomedServiceIds: string[] = []
      for (const b of blocks) {
        if (!doomed.has(b.id) || b.level !== 'frame' || b.parentId !== null) continue
        const service = await this.serviceRepository.getByFrameBlock(b.id)
        if (service) doomedServiceIds.push(service.id)
      }
      if (doomedServiceIds.length > 0) {
        // Batched: clear every board's mount of the doomed services, then delete the services
        // (two queries, not a listByService + per-mount remove + per-service delete loop).
        await this.workspaceMountRepository.removeByServices(doomedServiceIds)
        await this.serviceRepository.deleteMany(doomedServiceIds)
      }
    }
    await this.blockRepository.deleteMany(homeWorkspaceId, [...doomed])

    for (const b of blocks) {
      if (doomed.has(b.id)) continue
      const next = b.dependsOn.filter((d) => !doomed.has(d))
      if (next.length !== b.dependsOn.length) {
        await this.blockRepository.update(homeWorkspaceId, b.id, { dependsOn: next })
      }
    }
  }

  /** Toggle a dependency edge: target dependsOn source. */
  async toggleDependency(workspaceId: string, targetId: string, sourceId: string): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    if (targetId === sourceId) {
      throw new ValidationError('A block cannot depend on itself')
    }
    const { homeWorkspaceId, block: target } = await this.resolveBlock(workspaceId, targetId)
    // The source need only be visible to this board (it may be homed elsewhere); the edge is
    // stored as an id on the target, which lives at `homeWorkspaceId`.
    await this.resolveBlock(workspaceId, sourceId)
    const i = target.dependsOn.indexOf(sourceId)
    const next =
      i >= 0 ? target.dependsOn.filter((d) => d !== sourceId) : [...target.dependsOn, sourceId]
    await this.blockRepository.update(homeWorkspaceId, targetId, { dependsOn: next })
    return assertFound(await this.blockRepository.get(homeWorkspaceId, targetId), 'Block', targetId)
  }
}
