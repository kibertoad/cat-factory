import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import {
  registerServiceForFrame,
  requireWorkspace,
  seedBlocks,
  seedRiskPolicies,
  seedModelPresets,
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
  ServiceRehome,
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

  /** Owning user id for a board (string/owned, null/none, undefined/missing). */
  ownerOf(id: string): Promise<string | null | undefined> {
    return this.workspaceRepository.ownerOf(id)
  }

  /** Owning account id for a board (string/scoped, null/legacy, undefined/missing). */
  accountOf(id: string): Promise<string | null | undefined> {
    return this.workspaceRepository.accountOf(id)
  }

  async create(
    input: CreateWorkspaceInput,
    ownerUserId: string | null,
    accountId: string | null,
  ): Promise<WorkspaceSnapshot> {
    const workspace: Workspace = {
      id: this.idGenerator.next('ws'),
      name: input.name?.trim() || 'Untitled board',
      description: input.description?.trim() || null,
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

  /** Rename a board and/or update its description. */
  async update(
    id: string,
    patch: { name?: string; description?: string | null },
  ): Promise<Workspace> {
    await this.require(id)
    if (patch.name !== undefined) await this.workspaceRepository.rename(id, patch.name.trim())
    if ('description' in patch) {
      const desc = patch.description == null ? null : patch.description.trim() || null
      await this.workspaceRepository.setDescription(id, desc)
    }
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
    // Exclude HEADLESS internal blocks (public-API "initiative" runs) from the board projection —
    // they exist only to anchor an external run and must never render in the UI. Filtered here, at
    // the single SPA-facing snapshot read, not in the repository (the engine still sees them). See
    // BoardService.createInternalTask. Their executions are dropped from `executions` too, so the
    // external run's brief + LLM output never reach the SPA (the block filter alone would leave an
    // orphan execution referencing a hidden block). The durable driver never uses the snapshot —
    // production drives by run id, and the conformance/test harness now enumerates runs via
    // `executionRepository.listByWorkspace`, not this projection.
    const internalBlockIds = new Set(localBlocks.filter((b) => b.internal).map((b) => b.id))
    // Archived services: an archived top-level frame plus its whole subtree drop out of the
    // board projection (like `internal`), but the frame itself is surfaced under
    // `archivedServices` so the SPA can list + restore it. Restore is a flag flip, so nothing
    // is destroyed — the subtree reappears on the next refresh.
    //
    // This is derived in TWO passes because a service can be SHARED across boards: a frame homed
    // here (in `localBlocks`) and one archived on its HOME board but mounted here (pulled in only
    // by `composeBoard` below) must BOTH be hidden — otherwise archiving a shared service leaves
    // it fully visible on every other board that mounts it.
    //   Pass 1 (local): hide the internal blocks + every LOCAL archived frame's subtree. This is
    //   the reliable source for a home board's own archived services and their executions (those
    //   subtrees never survive into `composed`, so they can't be re-derived from it).
    const localArchivedFrames = localBlocks.filter(isArchivedServiceFrame)
    const localHidden = hiddenSubtreeIds(localBlocks, localArchivedFrames, internalBlockIds)
    const visibleBlocks = localBlocks.filter((b) => !localHidden.has(b.id))
    const composed = await this.composeBoard(visibleBlocks, mounts)
    //   Pass 2 (composed): a FOREIGN service archived on its home board reaches this board only via
    //   its mount, so `composeBoard` re-fetches its (archived) subtree via `listByServices`. Seed
    //   the final hide-set with pass 1's ids and grow it over the composed board so that foreign
    //   frame + subtree are dropped here too. A local frame re-pulled as "foreign" is already in
    //   `localHidden`, so it is not double-counted as a fresh foreign archive.
    const foreignArchivedFrames = composed.filter(
      (b) => isArchivedServiceFrame(b) && !localHidden.has(b.id),
    )
    const hiddenBlockIds = hiddenSubtreeIds(composed, foreignArchivedFrames, localHidden)
    const blocks = composed.filter((b) => !hiddenBlockIds.has(b.id))
    // Compose over ALL local executions, then drop the hidden ones (local subtree via `localHidden`,
    // foreign archived subtree via the composed pass) — a foreign archived run reaches this list
    // through `composeExecutions`' mount pull, so filtering only local executions would leak it.
    const composedExecutions = await this.composeExecutions(localExecutions, mounts)
    const executions = composedExecutions.filter((e) => !hiddenBlockIds.has(e.blockId))
    // Every archived service this board can list/restore: its own homed frames + any shared frame
    // it mounts that was archived on its home board.
    const archivedFrames = [...localArchivedFrames, ...foreignArchivedFrames]
    // The current built-in catalog versions, so the SPA can flag a workspace's stale
    // built-in copies and offer a reseed (see WorkspaceSnapshot.pipelineCatalogVersions).
    const pipelineCatalogVersions = Object.fromEntries(
      seedPipelines().map((p) => [p.id, p.version ?? 0]),
    )
    // The current built-in merge-preset catalog versions, so the SPA can flag a workspace's
    // stale built-in copies AND surface a brand-new built-in it doesn't have yet (see
    // WorkspaceSnapshot.riskPolicyCatalogVersions). Built here so it stays symmetric across
    // runtimes; the actual preset rows are attached by the facade's WorkspaceController.
    const riskPolicyCatalogVersions = Object.fromEntries(
      seedRiskPolicies().map((p) => [p.id, p.version]),
    )
    // The current built-in model-preset catalog versions, so the SPA can flag a workspace's
    // stale built-in copies AND surface a brand-new built-in it doesn't have yet (see
    // WorkspaceSnapshot.modelPresetCatalogVersions). Built here so it stays symmetric across
    // runtimes; the actual preset rows are attached by the facade's WorkspaceController.
    const modelPresetCatalogVersions = Object.fromEntries(
      seedModelPresets().map((p) => [p.id, p.version]),
    )
    return {
      workspace,
      blocks,
      pipelines,
      executions,
      pipelineCatalogVersions,
      riskPolicyCatalogVersions,
      modelPresetCatalogVersions,
      ...(archivedFrames.length ? { archivedServices: archivedFrames } : {}),
    }
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
    // One batched query for every mounted service's runs (not one round-trip per mount).
    for (const e of await this.executionRepository.listByServices(mounts.map((m) => m.serviceId))) {
      if (!byId.has(e.id)) byId.set(e.id, e)
    }
    return [...byId.values()]
  }

  async delete(id: string): Promise<void> {
    await this.require(id)
    // Re-home the SHARED services this board homes: a service another board still mounts must NOT
    // be destroyed just because its home board is deleted (both teams lose the shared subtree).
    // Resolve, per homed service, whether a surviving board mounts it and hand the cascade a
    // re-home plan; services with no other mount fall through to the normal reclaim.
    const rehome = await this.planSharedServiceRehome(id)
    await this.workspaceRepository.delete(id, rehome)
  }

  /**
   * For a board about to be deleted, decide which of the account-owned services it HOMES should be
   * re-homed (rather than destroyed) because another board still mounts them. Returns one entry per
   * such service naming the surviving board to inherit it (the earliest-created external mount, so
   * the choice is deterministic). A service mounted by no other board is omitted — the delete
   * cascade reclaims it as before. No-op (empty) when the service repos aren't wired.
   */
  private async planSharedServiceRehome(id: string): Promise<ServiceRehome[]> {
    if (!this.serviceRepository || !this.workspaceMountRepository) return []
    const blocks = await this.blockRepository.listByWorkspace(id)
    const frameIds = blocks
      .filter((b) => b.level === 'frame' && b.parentId === null)
      .map((b) => b.id)
    if (frameIds.length === 0) return []
    const homed = await this.serviceRepository.listByFrameBlocks(frameIds)
    if (homed.length === 0) return []
    // One batched mount read for every homed service (not a listByService per service).
    const mounts = await this.workspaceMountRepository.listByServiceIds(homed.map((s) => s.id))
    const externalByService = new Map<string, WorkspaceMount[]>()
    for (const m of mounts) {
      if (m.workspaceId === id) continue // the home board's own mount is going away with it
      const list = externalByService.get(m.serviceId)
      if (list) list.push(m)
      else externalByService.set(m.serviceId, [m])
    }
    const rehome: ServiceRehome[] = []
    for (const service of homed) {
      const external = externalByService.get(service.id)
      if (!external || external.length === 0) continue
      const target = external.reduce((a, b) => (a.createdAt <= b.createdAt ? a : b))
      rehome.push({ serviceId: service.id, toWorkspaceId: target.workspaceId })
    }
    return rehome
  }
}

/** An archived top-level service frame — the only kind of block that carries the archive marker. */
function isArchivedServiceFrame(b: Block): boolean {
  return Boolean(b.archived) && b.level === 'frame' && b.parentId === null
}

/**
 * The ids to drop from the board projection: everything in `seedIds` (the already-hidden set —
 * the headless `internal` blocks, and on the second pass the local archived subtree), plus every
 * frame in `hiddenFrames` AND its whole subtree (tasks/modules reach the board only through their
 * frame, so a hidden frame must take its descendants with it). Pure BFS over the `parentId` tree,
 * seeded with `seedIds` + the `hiddenFrames` ids.
 */
function hiddenSubtreeIds(
  blocks: Block[],
  hiddenFrames: Block[],
  seedIds: Set<string>,
): Set<string> {
  const hidden = new Set<string>(seedIds)
  for (const f of hiddenFrames) hidden.add(f.id)
  let grew = true
  while (grew) {
    grew = false
    for (const b of blocks) {
      if (b.parentId && hidden.has(b.parentId) && !hidden.has(b.id)) {
        hidden.add(b.id)
        grew = true
      }
    }
  }
  return hidden
}
