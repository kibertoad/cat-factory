import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import {
  registerServiceForFrame,
  requireWorkspace,
  seedBlocks,
  seedPipelines,
} from '@cat-factory/kernel'
import type {
  Block,
  ExecutionInstance,
  Workspace,
  WorkspaceMount,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
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
      await this.seedBoard(workspace.id)
    }
    return this.snapshot(workspace.id)
  }

  /**
   * Seed the demo architecture, registering each top-level frame as an account-owned service
   * (so seeded frames are shareable across the org exactly like ones created on the board) and
   * stamping every seeded block with its frame's service. A no-op service registration when
   * in-org sharing isn't wired leaves plain workspace-local blocks (legacy behaviour).
   */
  private async seedBoard(workspaceId: string): Promise<void> {
    const blocks = seedBlocks()
    const byId = new Map(blocks.map((b) => [b.id, b]))
    const topFrameOf = (b: Block): Block | undefined => {
      let cur: Block | undefined = b
      while (cur && !(cur.level === 'frame' && cur.parentId === null)) {
        cur = cur.parentId ? byId.get(cur.parentId) : undefined
      }
      return cur
    }
    const serviceByFrame = new Map<string, string | undefined>()
    for (const b of blocks) {
      if (b.level === 'frame' && b.parentId === null) {
        serviceByFrame.set(
          b.id,
          await registerServiceForFrame(
            {
              serviceRepository: this.serviceRepository,
              workspaceMountRepository: this.workspaceMountRepository,
              workspaceRepository: this.workspaceRepository,
              idGenerator: this.idGenerator,
              clock: this.clock,
            },
            workspaceId,
            b,
          ),
        )
      }
    }
    for (const b of blocks) {
      const frame = topFrameOf(b)
      await this.blockRepository.insert(workspaceId, b, frame ? serviceByFrame.get(frame.id) : null)
    }
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
    const [localBlocks, pipelines, localExecutions] = await Promise.all([
      this.blockRepository.listByWorkspace(id),
      this.pipelineRepository.listByWorkspace(id),
      this.executionRepository.listByWorkspace(id),
    ])
    const mounts =
      this.workspaceMountRepository && this.serviceRepository
        ? await this.workspaceMountRepository.listByWorkspace(id)
        : []
    const blocks = await this.composeBoard(localBlocks, mounts)
    const executions = await this.composeExecutions(localExecutions, mounts)
    return { workspace, blocks, pipelines, executions }
  }

  /**
   * Compose a workspace's board from the services it mounts: its own (locally created)
   * blocks plus the full subtree of any service mounted from another workspace in the
   * same org — so a shared service renders identically on every board, with one physical
   * copy (and therefore one shared task list + status). Each mounted frame's board
   * position/size is taken from the mount (the per-workspace layout override) — for a home
   * frame as much as one mounted from elsewhere, since a service frame's position is always
   * carried on the mount (that is what `moveBlock` writes). When the service repositories
   * aren't wired (or nothing is mounted) this is a no-op and the local blocks stand.
   */
  private async composeBoard(localBlocks: Block[], mounts: WorkspaceMount[]): Promise<Block[]> {
    if (!this.serviceRepository || mounts.length === 0) return localBlocks

    const byId = new Map(localBlocks.map((b) => [b.id, b]))
    const localIds = new Set(byId.keys())
    // The per-workspace layout override for each mounted service's frame.
    const frameLayout = new Map<string, { x: number; y: number; w?: number; h?: number }>()
    // Resolve every mounted service in one batched query (not a `get` per mount).
    const services = await this.serviceRepository.listByIds(mounts.map((m) => m.serviceId))
    const frameOf = new Map(services.map((s) => [s.id, s.frameBlockId]))
    const foreignServiceIds: string[] = []
    for (const mount of mounts) {
      const frameBlockId = frameOf.get(mount.serviceId)
      if (!frameBlockId) continue
      frameLayout.set(frameBlockId, {
        x: mount.position.x,
        y: mount.position.y,
        ...(mount.size ? { w: mount.size.w, h: mount.size.h } : {}),
      })
      // Pull in the subtree only for services homed in ANOTHER workspace — a local service's
      // blocks are already in `localBlocks`.
      if (!localIds.has(frameBlockId)) foreignServiceIds.push(mount.serviceId)
    }
    // One batched query for all foreign subtrees (not one per service).
    for (const b of await this.blockRepository.listByServices(foreignServiceIds)) {
      if (!byId.has(b.id)) byId.set(b.id, b)
    }

    return [...byId.values()].map((b) => {
      const layout = frameLayout.get(b.id)
      if (!layout) return b
      const next: Block = { ...b, position: { x: layout.x, y: layout.y } }
      if (layout.w !== undefined && layout.h !== undefined) next.size = { w: layout.w, h: layout.h }
      return next
    })
  }

  /**
   * Compose a workspace's executions from the services it mounts: its own runs plus those of
   * any service mounted from another workspace, so a shared service's run progress/status
   * renders on every board that mounts it — not just on its home workspace. Deduplicated by
   * run id (a home service's runs already appear in the local list). No-op when sharing isn't
   * wired or nothing is mounted.
   */
  private async composeExecutions(
    localExecutions: ExecutionInstance[],
    mounts: WorkspaceMount[],
  ): Promise<ExecutionInstance[]> {
    if (mounts.length === 0) return localExecutions
    const byId = new Map(localExecutions.map((e) => [e.id, e]))
    for (const mount of mounts) {
      for (const e of await this.executionRepository.listByService(mount.serviceId)) {
        if (!byId.has(e.id)) byId.set(e.id, e)
      }
    }
    return [...byId.values()]
  }

  async delete(id: string): Promise<void> {
    await this.require(id)
    await this.workspaceRepository.delete(id)
  }
}
