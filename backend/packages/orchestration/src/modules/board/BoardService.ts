import type {
  AddEpicInput,
  AddFrameInput,
  AddModuleInput,
  AddServiceFromRepoInput,
  AddTaskInput,
  ReparentInput,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import type { Block, BlockType, Position, ServiceConnection } from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import { BLOCK_TYPE_LABEL } from '@cat-factory/kernel'
import type {
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  ExecutionRepository,
  RepoProjectionRepository,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import { registerServiceForFrame, requireWorkspace } from '@cat-factory/kernel'
import {
  canReparent,
  descendantIds,
  gridSlot,
  involvedServiceIdsError,
  serviceConnectionsError,
  serviceOf,
  tasksOf,
  wouldCreateCycle,
} from './board.logic.js'

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
  /**
   * The workspace's default service-fragment selection. When wired, a new service
   * frame inherits the workspace default onto its `serviceFragmentIds` at creation, so
   * `code-aware` agents on its tasks pick up the org's standards out of the box. Absent
   * → new frames start with no service-level fragments.
   */
  serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository
  /**
   * Real-time push. When wired, every successful board mutation emits a coarse
   * {@link ExecutionEventPublisher.boardChanged} so OTHER users active on the workspace
   * (and every board mounting a shared service) see the create/rename/move/reparent/delete
   * live instead of only on the next refresh. Best-effort: a publish failure never fails the
   * mutation (the REST response already carried it, and clients reconcile on reconnect).
   * Absent (tests / no real-time transport) → mutations behave exactly as before.
   */
  executionEventPublisher?: ExecutionEventPublisher
}

/**
 * The kinds of coarse board change a mutation pushes. A closed union (rather than a free
 * string) so a typo can't silently produce an unrecognised signal — the SPA treats every
 * value the same (a debounced full refresh), but the conformance suite asserts specific
 * ones, and keeping the set explicit documents what the board service emits.
 */
export type BoardChangeReason =
  | 'block-added'
  | 'block-updated'
  | 'block-moved'
  | 'block-reparented'
  | 'block-removed'
  | 'epic-assigned'
  | 'dependency-toggled'

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
  private readonly serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository
  private readonly events?: ExecutionEventPublisher

  constructor({
    workspaceRepository,
    blockRepository,
    executionRepository,
    idGenerator,
    clock,
    repoProjectionRepository,
    serviceRepository,
    workspaceMountRepository,
    serviceFragmentDefaultsRepository,
    executionEventPublisher,
  }: BoardServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.repoProjectionRepository = repoProjectionRepository
    this.serviceRepository = serviceRepository
    this.workspaceMountRepository = workspaceMountRepository
    this.serviceFragmentDefaultsRepository = serviceFragmentDefaultsRepository
    this.events = executionEventPublisher
  }

  /**
   * Push a coarse board-changed signal for a successful mutation. `originWorkspaceId` MUST be
   * the workspace that physically HOMES the affected block (its `homeWorkspaceId`), not
   * necessarily the acting workspace: {@link FanOutEventPublisher} resolves the block's service
   * — and thus every workspace that mounts it — by looking the block up under this origin, so
   * passing a mounter's id for a block homed elsewhere would find nothing and collapse the
   * fan-out to that one board. Naming a block lets the change reach every mount; pass `null` for
   * a signal that should reach the origin workspace only (e.g. a per-workspace frame-layout
   * move). Best-effort: swallow any failure so a missed push never fails the already-persisted
   * mutation — the client reconciles by re-fetching its snapshot.
   *
   * When `originConnectionId` is given (a user-driven positional mutation — move/reparent —
   * carrying the acting tab's connection id), the realtime transport SKIPS delivering this
   * echo back to that connection: its REST response already carried the authoritative result,
   * so refreshing off its own event would only race an in-flight drag and snap the block back
   * to a stale position. Every OTHER subscriber still receives the coarse signal and refreshes.
   * Engine-driven board changes pass no origin id, so they fan out to everyone as before.
   */
  private async emitBoardChanged(
    originWorkspaceId: string,
    reason: BoardChangeReason,
    blockId: string | null,
    originConnectionId?: string | null,
  ): Promise<void> {
    try {
      await this.events?.boardChanged(originWorkspaceId, reason, blockId, originConnectionId)
    } catch {
      // best-effort; the REST response already carried the mutation
    }
  }

  /**
   * The workspace's default service-fragment selection that a NEW service frame
   * inherits. Empty when the defaults repo isn't wired or none is set; never throws so
   * frame creation isn't blocked by a defaults read.
   */
  private async defaultServiceFragmentIds(workspaceId: string): Promise<string[]> {
    if (!this.serviceFragmentDefaultsRepository) return []
    try {
      return await this.serviceFragmentDefaultsRepository.get(workspaceId)
    } catch {
      return []
    }
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

  /**
   * Resolve the home workspace to run a {@link removeBlock} against. Deletion is idempotent and
   * best-effort, so unlike {@link resolveBlock} this NEVER 404s: a block local to this workspace
   * resolves here; a block belonging to a service this workspace mounts resolves to that service's
   * home (so a shared frame is deleted from any board that mounts it); anything else — a block row
   * that's already gone, or one only another (un-mounted) workspace can see — resolves to THIS
   * workspace, where the caller mops up whatever related rows survive. Every cleanup the caller
   * does is scoped to the returned workspace, so falling back here can only ever touch this
   * workspace's data, never reach across into another's.
   */
  private async resolveBlockHomeForRemoval(workspaceId: string, id: string): Promise<string> {
    const local = await this.blockRepository.get(workspaceId, id)
    if (local) return workspaceId
    if (this.serviceRepository && this.workspaceMountRepository) {
      const found = await this.blockRepository.findById(id)
      if (
        found?.serviceId &&
        (await this.workspaceMountRepository.get(workspaceId, found.serviceId))
      ) {
        return found.workspaceId
      }
    }
    return workspaceId
  }

  /** Add a top-level frame (service/api/database/…) to the board. */
  async addFrame(workspaceId: string, input: AddFrameInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const blocks = await this.blockRepository.listByWorkspace(workspaceId)
    const type = input.type as BlockType
    const count = blocks.filter((b) => b.type === type).length + 1
    const serviceFragmentIds = await this.defaultServiceFragmentIds(workspaceId)
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
      ...(serviceFragmentIds.length ? { serviceFragmentIds } : {}),
    }
    const serviceId = await this.registerService(workspaceId, block)
    await this.blockRepository.insert(workspaceId, block, serviceId)
    await this.emitBoardChanged(workspaceId, 'block-added', block.id)
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
    // The monorepo flag is sent with the add request (no separate up-front PATCH).
    // Persist it when provided so it sticks for subsequent adds + the repo picker, then
    // proceed with the guards below reading the now-current flag.
    if (input.isMonorepo !== undefined && input.isMonorepo !== repo.isMonorepo) {
      await this.repoProjectionRepository.setMonorepo(workspaceId, repo.githubId, input.isMonorepo)
      repo.isMonorepo = input.isMonorepo
    }
    // Normalise the requested service subdirectory to a clean, SAFE relative path:
    // strip slashes/`.` and reject any `..` segment, so a stored directory can never
    // point an agent's cwd outside the checkout (the harness enforces the same — this
    // is defence in depth, and surfaces a clean error before the row is written).
    const directory = normalizeServiceDirectory(input.directory)
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
    // Each subdirectory of a monorepo backs at most one service — reject a duplicate so
    // two frames don't fight over the same subtree (each resolves to the same repo+dir).
    if (repo.isMonorepo && directory && this.serviceRepository) {
      // One batched read for every frame's service, not a getByFrameBlock per frame (N+1).
      const frameIds = blocks.filter((b) => b.level === 'frame').map((b) => b.id)
      const existing = await this.serviceRepository.listByFrameBlocks(frameIds)
      if (existing.some((s) => s.repoGithubId === repo.githubId && s.directory === directory)) {
        throw new ValidationError(`A service for '${directory}' already exists in this repository`)
      }
    }
    const frames = blocks.filter((b) => b.level === 'frame').length
    const title = directory ? (directory.split('/').pop() ?? repo.name) : repo.name
    const serviceFragmentIds = await this.defaultServiceFragmentIds(workspaceId)
    const frameType = input.type ?? 'service'
    const roleLabel = BLOCK_TYPE_LABEL[frameType]
    const block: Block = {
      id: this.idGenerator.next('blk'),
      title,
      type: frameType,
      description: directory
        ? `${roleLabel} backed by ${repo.owner}/${repo.name} (${directory}/).`
        : `${roleLabel} backed by ${repo.owner}/${repo.name}.`,
      position: input.position ?? { x: 80 + (frames % 5) * 48, y: 80 + (frames % 5) * 48 },
      status: 'ready',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'frame',
      parentId: null,
      ...(serviceFragmentIds.length ? { serviceFragmentIds } : {}),
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
    await this.emitBoardChanged(workspaceId, 'block-added', block.id)
    return block
  }

  /**
   * A document repository is authored, not implemented: it accepts only document/spike tasks
   * (there is no code-producing pipeline for it). Enforced everywhere a task can enter a frame
   * (create AND reparent) so the board never holds an un-runnable feature/bug task under a doc
   * frame — the gate at a single entry point is not enough because drag-drop moves in too.
   */
  private assertTaskTypeAllowed(frame: Block | undefined, taskType: Block['taskType']): void {
    if (frame?.type === 'document' && taskType !== 'document' && taskType !== 'spike') {
      throw new ValidationError('A document repository only accepts document or spike tasks')
    }
  }

  /** Add a task inside a container (a service frame or a module). */
  async addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    createdBy?: string | null,
  ): Promise<Block> {
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
    const taskType = input.taskType ?? 'feature'
    this.assertTaskTypeAllowed(service, taskType)
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
      // The kind of work, chosen on the create form; defaults to a feature task.
      taskType,
    }
    // Small per-type form fields (bug severity / repro, spike timebox, …), when given.
    if (input.taskTypeFields && Object.keys(input.taskTypeFields).length) {
      block.taskTypeFields = input.taskTypeFields
    }
    // Optional epic membership at creation (the epic-import spawn path passes this so
    // every child task joins the epic it was imported under).
    if (input.epicId) block.epicId = input.epicId
    // The signed-in user who created the task, for "notify the task creator"
    // notification routing. Null with auth disabled (local/dev).
    if (createdBy != null) block.createdBy = createdBy
    // Optional run configuration chosen at creation: which merge policy governs the
    // task's auto-merge, and the pipeline its Run controls default to. Empty strings
    // are treated as "not set" (workspace default preset / no pinned pipeline).
    if (input.mergePresetId) block.mergePresetId = input.mergePresetId
    if (input.modelPresetId) block.modelPresetId = input.modelPresetId
    if (input.pipelineId) block.pipelineId = input.pipelineId
    // Task-level agent-contributed config values (e.g. the Tester's environment),
    // chosen on the creation form from the selected pipeline's contributing agents.
    if (input.agentConfig && Object.keys(input.agentConfig).length) {
      block.agentConfig = input.agentConfig
    }
    // A human-set TECHNICAL flag from the create form (authoritative; the engine never
    // overrides it). Omitted ⇒ left undetermined for the spec phase to infer.
    if (input.technical !== undefined) block.technical = input.technical
    await this.blockRepository.insert(
      homeWorkspaceId,
      block,
      await this.serviceForContainer(blocks, container),
    )
    // Origin = the block's HOME (the mounted service's home when added to a shared board), so
    // the fan-out reaches every workspace mounting the service, not just the acting one.
    await this.emitBoardChanged(homeWorkspaceId, 'block-added', block.id)
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
    // Origin = the block's HOME so a module added to a mounted service fans out to all mounts.
    await this.emitBoardChanged(homeWorkspaceId, 'block-added', block.id)
    return block
  }

  /**
   * Add an `epic`-level grouping node. An epic is NOT a structural container — tasks
   * join it via their `epicId`, not by reparenting — so it is a plain board block that
   * is never registered as an account-owned service. `parentId` is an optional placement
   * under a service/module (validated reparent-legal); omitted ⇒ a top-level node.
   */
  async addEpic(workspaceId: string, input: AddEpicInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    let parentId: string | null = null
    if (input.parentId) {
      const { block: parent } = await this.resolveBlock(workspaceId, input.parentId)
      if (!canReparent('epic', parent)) {
        throw new ValidationError(`An epic cannot be placed inside a ${parent.level}`)
      }
      parentId = input.parentId
    }
    const block: Block = {
      id: this.idGenerator.next('epic'),
      title: input.title.trim(),
      // An epic has no architectural type of its own; tag it as an integration-ish
      // grouping. Only its `level` drives rendering/behaviour.
      type: 'service',
      description: input.description?.trim() ?? '',
      position: input.position,
      status: 'planned',
      progress: 0,
      dependsOn: [],
      executionId: null,
      level: 'epic',
      parentId,
    }
    await this.blockRepository.insert(workspaceId, block)
    await this.emitBoardChanged(workspaceId, 'block-added', block.id)
    return block
  }

  /**
   * Assign a task to an epic, or detach it (`epicId === null`). Membership is recorded on
   * the task's `epicId` and is independent of its structural `parentId`, so a task keeps
   * its place under a module/service while joining an epic that groups tasks across the
   * board. Validates the epic is visible and actually `epic`-level.
   */
  async assignToEpic(workspaceId: string, taskId: string, epicId: string | null): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block: task } = await this.resolveBlock(workspaceId, taskId)
    if (task.level !== 'task') {
      throw new ValidationError('Only tasks can belong to an epic')
    }
    if (epicId) {
      const { block: epic } = await this.resolveBlock(workspaceId, epicId)
      if (epic.level !== 'epic') {
        throw new ValidationError('A task can only be assigned to an epic-level block')
      }
    }
    await this.blockRepository.update(homeWorkspaceId, taskId, { epicId })
    // Origin = the task's HOME so the fan-out resolves the (possibly mounted) service's boards.
    await this.emitBoardChanged(homeWorkspaceId, 'epic-assigned', taskId)
    return assertFound(await this.blockRepository.get(homeWorkspaceId, taskId), 'Block', taskId)
  }

  async moveBlock(
    workspaceId: string,
    id: string,
    position: Position,
    originConnectionId?: string | null,
  ): Promise<Block> {
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
        // The frame's position is this workspace's private layout override — other boards
        // mounting the service keep their own spot, so this signal is origin-only.
        await this.emitBoardChanged(workspaceId, 'block-moved', null, originConnectionId)
        return { ...block, position }
      }
    }
    // A non-frame block, or a legacy frame with no mount: move the shared block at its home.
    await this.blockRepository.update(homeWorkspaceId, id, { position })
    // Origin = the block's HOME so moving a shared block fans the new position out to all mounts.
    await this.emitBoardChanged(homeWorkspaceId, 'block-moved', id, originConnectionId)
    return assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id)
  }

  async updateBlock(workspaceId: string, id: string, patch: UpdateBlockInput): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await this.resolveBlock(workspaceId, id)
    // `serviceFragmentIds` is a service-level (frame) setting the engine only reads off
    // the owning service frame; ignore it on non-frame blocks so it never persists as
    // dead data (the inspector only exposes the picker on frames anyway).
    let effective = patch
    if (patch.serviceFragmentIds !== undefined && block.level !== 'frame') {
      const { serviceFragmentIds: _ignored, ...rest } = patch
      effective = rest
    }
    // `serviceConnections` lives only on service-type frames (the consumer end of each
    // edge); dropped elsewhere for the same never-persist-dead-data reason as above.
    if (effective.serviceConnections !== undefined) {
      if (block.level !== 'frame' || block.type !== 'service') {
        const { serviceConnections: _ignored, ...rest } = effective
        effective = rest
      } else if (effective.serviceConnections.length) {
        // Resolve targets from ONE home-workspace read; only ids not homed here (a
        // service mounted from another workspace) fall back to the cross-home-aware
        // per-id resolve — a bounded user-authored list, not a data-sized loop.
        const homeBlocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
        const byId = new Map(homeBlocks.map((b) => [b.id, b]))
        const resolved = new Map<string, Block>()
        for (const { serviceBlockId } of effective.serviceConnections) {
          if (byId.has(serviceBlockId) || resolved.has(serviceBlockId)) continue
          const found = await this.resolveBlock(workspaceId, serviceBlockId).catch(() => null)
          if (found) resolved.set(serviceBlockId, found.block)
        }
        const error = serviceConnectionsError(
          id,
          effective.serviceConnections,
          (targetId) => byId.get(targetId) ?? resolved.get(targetId),
        )
        if (error) throw new ValidationError(error)
      }
    }
    // `involvedServiceIds` is a task-level selection drawn from the enclosing service
    // frame's connection neighbors; dropped on non-tasks, validated on tasks.
    if (effective.involvedServiceIds !== undefined) {
      if (block.level !== 'task') {
        const { involvedServiceIds: _ignored, ...rest } = effective
        effective = rest
      } else if (effective.involvedServiceIds.length) {
        const homeBlocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
        // A connection neighbor can be a service mounted from another workspace — the SPA
        // offers those (it computes neighbors over the composed board), so validate against
        // the same universe: resolve each selected id not homed here (cross-home aware) and
        // fold its block in, so an INCOMING edge from a mounted foreign consumer counts as a
        // neighbor too. A bounded user-authored list (contract-capped), not a data-sized loop.
        const byId = new Set(homeBlocks.map((b) => b.id))
        const foreign: Block[] = []
        for (const sid of effective.involvedServiceIds) {
          if (byId.has(sid)) continue
          byId.add(sid)
          const found = await this.resolveBlock(workspaceId, sid).catch(() => null)
          if (found) foreign.push(found.block)
        }
        const error = involvedServiceIdsError(
          [...homeBlocks, ...foreign],
          block,
          effective.involvedServiceIds,
        )
        if (error) throw new ValidationError(error)
      }
    }
    await this.blockRepository.update(homeWorkspaceId, id, effective)
    // Origin = the block's HOME so editing a shared block fans out to every board mounting it.
    await this.emitBoardChanged(homeWorkspaceId, 'block-updated', id)
    return assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id)
  }

  /** Move a block into a new container at a new local position. */
  async reparent(
    workspaceId: string,
    id: string,
    input: ReparentInput,
    originConnectionId?: string | null,
  ): Promise<Block> {
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

    // The destination's enclosing frame drives two things: the doc-repo task gate (same as
    // addTask — drag-drop must not smuggle a feature/bug/recurring task into a doc frame) and
    // the moved task's inherited `type`, which is behavioural for the frame repo roles. Load
    // the parent's workspace blocks once here; the branches below reuse this list.
    const destBlocks = await this.blockRepository.listByWorkspace(parentHome)
    const destFrame = serviceOf(destBlocks, parent)
    if (block.level === 'task') {
      this.assertTaskTypeAllowed(destFrame, block.taskType)
    }
    // A task inherits its enclosing frame's type, so a move re-stamps it (no-op when unchanged
    // or when the destination isn't a resolvable frame). Non-task blocks keep their own type.
    const movedType: BlockType = block.level === 'task' && destFrame ? destFrame.type : block.type

    // Same physical home (the common case, incl. two of the workspace's own services): move in
    // place and re-stamp `service_id`, the physical scope key that decides which boards render
    // the subtree and where its events fan out. No-op re-stamp when sharing isn't wired or the
    // destination frame isn't a registered service.
    if (blockHome === parentHome) {
      await this.blockRepository.update(blockHome, id, {
        parentId: input.parentId,
        position: input.position,
        ...(movedType !== block.type ? { type: movedType } : {}),
      })
      if (this.serviceRepository) {
        const destService = await this.serviceForContainer(destBlocks, parent)
        await this.blockRepository.setService(
          blockHome,
          [...descendantIds(destBlocks, id)],
          destService ?? null,
        )
      }
      // Origin = the block's HOME so the re-stamped subtree fans out to every mounting board.
      await this.emitBoardChanged(blockHome, 'block-reparented', id, originConnectionId)
      return assertFound(await this.blockRepository.get(blockHome, id), 'Block', id)
    }

    // Cross-home: the block and its new parent belong to two services homed in different
    // workspaces (both mounted on this board). Keep the invariant that a service's blocks live
    // in its home workspace by MOVING the subtree's rows — and any executions on them — to the
    // destination service's home, re-stamped with the destination service.
    //
    // Capture the SOURCE service's mounting boards BEFORE the move (afterwards the subtree no
    // longer resolves to the source service), so every board that showed the block at its old
    // home can refresh it away. The destination side is reached by the post-move emit below.
    const sourceFanout = new Set<string>([blockHome])
    if (this.workspaceMountRepository) {
      for (const ws of await this.workspaceMountRepository.listWorkspaceIdsMountingBlock(
        blockHome,
        id,
      )) {
        sourceFanout.add(ws)
      }
    }
    const srcBlocks = await this.blockRepository.listByWorkspace(blockHome)
    const ids = [...descendantIds(srcBlocks, id)]
    const subtree = ids
      .map((bid) => srcBlocks.find((b) => b.id === bid))
      .filter((b): b is Block => b !== undefined)
    const destService = (await this.serviceForContainer(destBlocks, parent)) ?? null
    for (const b of subtree) {
      const moved =
        b.id === id
          ? { ...b, parentId: input.parentId, position: input.position, type: movedType }
          : b
      await this.blockRepository.insert(parentHome, moved, destService)
      const exec = await this.executionRepository.getByBlock(blockHome, b.id)
      if (exec) {
        await this.executionRepository.deleteByBlock(blockHome, b.id)
        await this.executionRepository.upsert(parentHome, exec)
      }
    }
    await this.blockRepository.deleteMany(blockHome, ids)
    // Drop dependency + epic edges in the source workspace that now dangle to the moved subtree.
    await this.pruneDanglingEdges(blockHome, srcBlocks, new Set(ids))
    // Destination side: origin = the new HOME so the moved subtree fans out to the destination
    // service's mounts (and that board). Source side: the block is gone from its old service, so
    // the block→service join can't resolve it anymore — notify the captured source boards
    // directly (origin-only) so they refresh the subtree away.
    await this.emitBoardChanged(parentHome, 'block-reparented', id, originConnectionId)
    for (const ws of sourceFanout) {
      if (ws !== parentHome) {
        await this.emitBoardChanged(ws, 'block-reparented', null, originConnectionId)
      }
    }
    return assertFound(await this.blockRepository.get(parentHome, id), 'Block', id)
  }

  /**
   * After a set of blocks leaves `homeWorkspaceId` (deleted, or moved to another workspace),
   * drop the now-dangling references on the surviving blocks in one pass: dependency edges
   * pointing into `removed`, and epic membership whose epic was removed (the member task itself
   * survives — epic grouping is non-structural, never cascaded). Shared by the delete and the
   * reparent/detach paths so they can't drift.
   */
  private async pruneDanglingEdges(
    homeWorkspaceId: string,
    survivors: Block[],
    removed: Set<string>,
  ): Promise<void> {
    for (const b of survivors) {
      if (removed.has(b.id)) continue
      const patch: {
        dependsOn?: string[]
        epicId?: string | null
        serviceConnections?: ServiceConnection[]
        involvedServiceIds?: string[]
      } = {}
      const next = b.dependsOn.filter((d) => !removed.has(d))
      if (next.length !== b.dependsOn.length) patch.dependsOn = next
      if (b.epicId && removed.has(b.epicId)) patch.epicId = null
      // Service-connection edges into the removed set, and task selections of a removed
      // involved service, dangle the same way dependency edges do — drop them here too.
      const connections = (b.serviceConnections ?? []).filter((c) => !removed.has(c.serviceBlockId))
      if (connections.length !== (b.serviceConnections ?? []).length) {
        patch.serviceConnections = connections
      }
      const involved = (b.involvedServiceIds ?? []).filter((sid) => !removed.has(sid))
      if (involved.length !== (b.involvedServiceIds ?? []).length) {
        patch.involvedServiceIds = involved
      }
      if (Object.keys(patch).length) {
        await this.blockRepository.update(homeWorkspaceId, b.id, patch)
      }
    }
  }

  /** Delete a block and all its descendants, dropping dangling dependencies. */
  async removeBlock(workspaceId: string, id: string): Promise<void> {
    await this.requireWorkspace(workspaceId)
    // Resolve the block at its home so a shared service's block can be deleted from any board
    // that mounts it (the delete then applies to the one shared copy everywhere). Deletion is
    // best-effort and idempotent: if the block row is already GONE (e.g. a half-deleted service
    // that left a dangling mount/repo-link/execution), we must NOT 404 — a thing not existing
    // can't be allowed to block cleanup of the related entities that do still exist. The resolve
    // never throws; it falls back to this workspace, and every cleanup below is scoped to that
    // home, so we tear down whatever references the id (+ its surviving descendants) without ever
    // touching another workspace's data.
    const homeWorkspaceId = await this.resolveBlockHomeForRemoval(workspaceId, id)
    // Capture the boards this removal must reach BEFORE we delete the block + drop its service's
    // mounts (after which the block→service→mounts join can't resolve anything). The union of the
    // acting workspace and every workspace mounting the doomed service is then notified post-delete.
    const fanoutTargets = new Set<string>([workspaceId])
    if (this.workspaceMountRepository) {
      for (const ws of await this.workspaceMountRepository.listWorkspaceIdsMountingBlock(
        homeWorkspaceId,
        id,
      )) {
        fanoutTargets.add(ws)
      }
    }
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
      const doomedServiceIds = new Set<string>()
      // One batched read for every doomed top-level frame's service, not a getByFrameBlock
      // per frame (N+1).
      const doomedFrameIds = blocks
        .filter((b) => doomed.has(b.id) && b.level === 'frame' && b.parentId === null)
        .map((b) => b.id)
      for (const service of await this.serviceRepository.listByFrameBlocks(doomedFrameIds)) {
        doomedServiceIds.add(service.id)
      }
      // The frame block may already be gone (the dangling case), so it isn't in `blocks` above —
      // look the service up directly by the deleted id too, so the orphaned service + its mounts
      // are still reclaimed rather than lingering in the org catalog forever.
      const danglingService = await this.serviceRepository.getByFrameBlock(id)
      if (danglingService) doomedServiceIds.add(danglingService.id)
      if (doomedServiceIds.size > 0) {
        // Batched: clear every board's mount of the doomed services, then delete the services
        // (two queries, not a listByService + per-mount remove + per-service delete loop).
        const ids = [...doomedServiceIds]
        await this.workspaceMountRepository.removeByServices(ids)
        await this.serviceRepository.deleteMany(ids)
      }
    }
    await this.blockRepository.deleteMany(homeWorkspaceId, [...doomed])

    await this.pruneDanglingEdges(homeWorkspaceId, blocks, doomed)

    // The block + any shared service are now gone, so fan out per captured target (blockId is
    // unresolvable post-delete) — every board that showed the block refreshes it away.
    for (const ws of fanoutTargets) {
      await this.emitBoardChanged(ws, 'block-removed', null)
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
    const { block: source } = await this.resolveBlock(workspaceId, sourceId)
    const i = target.dependsOn.indexOf(sourceId)
    if (i < 0) {
      // Adding a NEW edge. Both endpoints must be tasks: only a task ever reaches `done`, so an
      // edge onto a frame/module/epic (which never executes) would wedge the engine's start gate
      // forever (`dependenciesMet` requires the blocker to be `done`). Reject it up front.
      if (target.level !== 'task' || source.level !== 'task') {
        throw new ValidationError('Only tasks can have dependency edges')
      }
      // Reject it if it would close a cycle, so the engine's dependency gate + auto-start can
      // never deadlock on a circular graph. Checked against the home workspace's blocks.
      const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
      if (wouldCreateCycle(blocks, targetId, sourceId)) {
        throw new ValidationError('That dependency would create a cycle')
      }
    }
    const next =
      i >= 0 ? target.dependsOn.filter((d) => d !== sourceId) : [...target.dependsOn, sourceId]
    await this.blockRepository.update(homeWorkspaceId, targetId, { dependsOn: next })
    // (emit happens after the post-write cycle re-check below settles, with the block's HOME.)
    // The cycle check above is read-then-write, so two concurrent adds could each pass against a
    // pre-edge snapshot and together close a loop. Re-verify against the now-written graph and
    // roll the edge back if a cycle slipped in — cheap and the only point where edges are added.
    if (i < 0) {
      const after = await this.blockRepository.listByWorkspace(homeWorkspaceId)
      if (wouldCreateCycle(after, targetId, sourceId)) {
        await this.blockRepository.update(homeWorkspaceId, targetId, {
          dependsOn: target.dependsOn,
        })
        throw new ValidationError('That dependency would create a cycle')
      }
    }
    // Origin = the target's HOME so toggling an edge on a shared task fans out to all mounts.
    await this.emitBoardChanged(homeWorkspaceId, 'dependency-toggled', targetId)
    return assertFound(await this.blockRepository.get(homeWorkspaceId, targetId), 'Block', targetId)
  }
}

/**
 * Coerce a user-supplied monorepo service subdirectory into a clean, SAFE relative path
 * (or undefined when absent/empty): normalise separators, drop `.`/empty segments, and
 * reject any `..` segment or absolute path so the stored value can never escape the repo
 * checkout when it later becomes an agent's cwd. Mirrors the harness's `sanitizeService
 * Directory`, kept here so a bad value is rejected before the service row is written.
 */
export function normalizeServiceDirectory(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const segments = raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.')
  if (segments.length === 0) return undefined
  if (segments.some((s) => s === '..')) {
    throw new ValidationError('Service directory must be a path inside the repository')
  }
  return segments.join('/')
}
