import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import { requireWorkspace, seedBlocks, seedPipelines } from '@cat-factory/kernel'
import type { Block, Workspace, WorkspaceSnapshot } from '@cat-factory/kernel'
import type {
  BlockRepository,
  ExecutionRepository,
  PipelineRepository,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'

export { requireWorkspace } from '@cat-factory/kernel'

export interface WorkspaceServiceDependencies {
  workspaceRepository: WorkspaceRepository
  blockRepository: BlockRepository
  pipelineRepository: PipelineRepository
  executionRepository: ExecutionRepository
  idGenerator: IdGenerator
  clock: Clock
  /**
   * In-org shared services. When wired, a board snapshot is composed from the services
   * the workspace mounts: its own frames plus any service mounted from another
   * workspace in the same org, with each frame's layout taken from its mount.
   */
  serviceRepository?: ServiceRepository
  workspaceMountRepository?: WorkspaceMountRepository
}

/** Creates, reads and deletes boards (workspaces) and assembles snapshots. */
export class WorkspaceService {
  private readonly workspaceRepository: WorkspaceRepository
  private readonly blockRepository: BlockRepository
  private readonly pipelineRepository: PipelineRepository
  private readonly executionRepository: ExecutionRepository
  private readonly idGenerator: IdGenerator
  private readonly clock: Clock
  private readonly serviceRepository?: ServiceRepository
  private readonly workspaceMountRepository?: WorkspaceMountRepository

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator,
    clock,
    serviceRepository,
    workspaceMountRepository,
  }: WorkspaceServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.serviceRepository = serviceRepository
    this.workspaceMountRepository = workspaceMountRepository
  }

  /**
   * Boards visible to a user (see {@link WorkspaceVisibility}). A `null` scope
   * means auth is disabled and all boards are returned.
   */
  list(scope: WorkspaceVisibility): Promise<Workspace[]> {
    return this.workspaceRepository.listVisible(scope)
  }

  /** Owning user id for a board (number/owned, null/none, undefined/missing). */
  ownerOf(id: string): Promise<number | null | undefined> {
    return this.workspaceRepository.ownerOf(id)
  }

  /** Owning account id for a board (string/scoped, null/legacy, undefined/missing). */
  accountOf(id: string): Promise<string | null | undefined> {
    return this.workspaceRepository.accountOf(id)
  }

  async create(
    input: CreateWorkspaceInput,
    ownerUserId: number | null,
    accountId: string | null,
  ): Promise<WorkspaceSnapshot> {
    const workspace: Workspace = {
      id: this.idGenerator.next('ws'),
      name: input.name?.trim() || 'Untitled board',
      createdAt: this.clock.now(),
      accountId,
    }
    await this.workspaceRepository.create(workspace, ownerUserId, accountId)

    // The built-in pipeline catalog is product configuration, not sample data, so
    // every board gets it — including the empty boards real users start with.
    for (const pipeline of seedPipelines()) {
      await this.pipelineRepository.insert(workspace.id, pipeline)
    }
    // The sample architecture blocks are opt-in (demo boards + the test fixtures);
    // production boards start empty (the SPA creates with `seed: false`).
    if (input.seed ?? true) {
      for (const block of seedBlocks()) {
        await this.blockRepository.insert(workspace.id, block)
      }
    }
    return this.snapshot(workspace.id)
  }

  /** Rename a board. */
  async rename(id: string, name: string): Promise<Workspace> {
    await this.require(id)
    await this.workspaceRepository.rename(id, name.trim())
    return this.require(id)
  }

  require(id: string): Promise<Workspace> {
    return requireWorkspace(this.workspaceRepository, id)
  }

  async snapshot(id: string): Promise<WorkspaceSnapshot> {
    const workspace = await this.require(id)
    const [localBlocks, pipelines, executions] = await Promise.all([
      this.blockRepository.listByWorkspace(id),
      this.pipelineRepository.listByWorkspace(id),
      this.executionRepository.listByWorkspace(id),
    ])
    const blocks = await this.composeBoard(id, localBlocks)
    return { workspace, blocks, pipelines, executions }
  }

  /**
   * Compose a workspace's board from the services it mounts: its own (locally created)
   * blocks plus the full subtree of any service mounted from another workspace in the
   * same org — so a shared service renders identically on every board, with one physical
   * copy (and therefore one shared task list + status). Each mounted frame's board
   * position/size is taken from the mount (the per-workspace layout override). When the
   * service repositories aren't wired this is a no-op and the local blocks stand.
   */
  private async composeBoard(workspaceId: string, localBlocks: Block[]): Promise<Block[]> {
    if (!this.workspaceMountRepository || !this.serviceRepository) return localBlocks
    const mounts = await this.workspaceMountRepository.listByWorkspace(workspaceId)
    if (mounts.length === 0) return localBlocks

    const byId = new Map(localBlocks.map((b) => [b.id, b]))
    const localIds = new Set(byId.keys())
    // Layout override for the frames of services mounted FROM ELSEWHERE only. A locally
    // homed frame keeps its own `block.position` (authoritative + movable); an external
    // frame is positioned by this workspace's mount (its home block.position is the home's
    // layout, not ours).
    const externalFrameLayout = new Map<string, { x: number; y: number; w?: number; h?: number }>()
    for (const mount of mounts) {
      const service = await this.serviceRepository.get(mount.serviceId)
      if (!service || localIds.has(service.frameBlockId)) continue
      externalFrameLayout.set(service.frameBlockId, {
        x: mount.position.x,
        y: mount.position.y,
        ...(mount.size ? { w: mount.size.w, h: mount.size.h } : {}),
      })
      for (const b of await this.blockRepository.listByService(mount.serviceId)) {
        if (!byId.has(b.id)) byId.set(b.id, b)
      }
    }

    return [...byId.values()].map((b) => {
      const layout = externalFrameLayout.get(b.id)
      if (!layout) return b
      const next: Block = { ...b, position: { x: layout.x, y: layout.y } }
      if (layout.w !== undefined && layout.h !== undefined) next.size = { w: layout.w, h: layout.h }
      return next
    })
  }

  async delete(id: string): Promise<void> {
    await this.require(id)
    await this.workspaceRepository.delete(id)
  }
}
