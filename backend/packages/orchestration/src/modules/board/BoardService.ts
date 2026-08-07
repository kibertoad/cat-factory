import type {
  AddEpicInput,
  AddFrameInput,
  AddModuleInput,
  AddServiceFromRepoInput,
  AddTaskInput,
  BlockEditActor,
  ReparentInput,
  ResizeBlockInput,
  UpdateBlockInput,
} from '@cat-factory/contracts'
import { moduleNameInContainer } from '@cat-factory/contracts'
import type {
  Block,
  BlockStatus,
  BlockType,
  BoardChange,
  Position,
  PreloadedBlocks,
} from '@cat-factory/kernel'
import { assertFound, ValidationError } from '@cat-factory/kernel'
import { BLOCK_TYPE_LABEL } from '@cat-factory/kernel'
import type {
  BlockRepository,
  Clock,
  ExecutionEventPublisher,
  ExecutionRepository,
  GitHubRepo,
  GroupCacheHandle,
  InitiativeRepository,
  DocumentRepository,
  Logger,
  RepoProjectionRepository,
  ResolveRunRepoContext,
  RiskPolicyRepository,
  Service,
  ServiceFragmentDefaultsRepository,
  ServiceRepository,
  TaskRepository,
  TaskTypeRegistry,
  TaskTypeSuppressionRepository,
  PromptFragmentSource,
  WorkspaceMount,
  WorkspaceMountRepository,
  WorkspaceRepository,
} from '@cat-factory/kernel'
import type { IdGenerator } from '@cat-factory/kernel'
import {
  applyMountLayout,
  noopLogger,
  registerServiceForFrame,
  requireWorkspace,
} from '@cat-factory/kernel'
import { createBoardLayoutWrites } from './layoutWrites.js'
import { createMountProjection } from './mountProjection.js'
import { pruneDanglingEdges, reclaimDoomedEntities } from './removal-cascade.js'
import {
  canReparent,
  descendantIds,
  gridSlot,
  serviceOf,
  tasksOf,
  unfinishedTasksUnder,
  wouldCreateCycle,
} from './board.logic.js'
import type { ReviewFrictionNotificationReader } from './reviewFrictionGuard.js'
import { ReviewFrictionGuard } from './reviewFrictionGuard.js'
import type { WorkspaceSettingsReader } from './workspaceSettingsReader.js'
import type { NewServiceFrameDefaults } from './newServiceFrameDefaults.js'
import { resolveNewServiceFrameDefaults } from './newServiceFrameDefaults.js'
import { createInternalAnchors } from './internalAnchors.js'
import { PublicBoardReads } from './publicBoardReads.js'
import { buildReviewDescription, resolveReviewTaskTarget } from './reviewTaskTarget.js'
import type { BlockPatchNarrowing } from './blockPatchNarrowing.js'
import { createBlockPatchNarrowing } from './blockPatchNarrowing.js'
import type { TaskTypeCreationDefaults } from './taskTypeCreationDefaults.js'
import { createTaskTypeCreationDefaults } from './taskTypeCreationDefaults.js'
import type { RiskPolicySelectionGuard } from './riskPolicySelectionGuard.js'
import { createRiskPolicySelectionGuard } from './riskPolicySelectionGuard.js'

export type { ReviewFrictionNotificationReader } from './reviewFrictionGuard.js'
export type { WorkspaceSettingsReader } from './workspaceSettingsReader.js'

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
   * The workspace repo-projection cache (`AppCaches.repoProjection`, caching-layer
   * slice 3). {@link BoardService.addServiceFromRepo} flips a repo's monorepo flag
   * directly on the projection (a resolver-visible field), so it must drop the
   * workspace's group afterwards — exactly as `GitHubSyncService.setRepoMonorepo` does
   * for the same write on the GitHub-connect path. Absent (tests / the Worker's
   * pass-through profile) ⇒ the invalidation is a no-op.
   */
  repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
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
   * Initiative persistence, present only when the initiatives module is wired. Backs the
   * cascade cleanup in {@link BoardService.removeBlock}: deleting an `initiative`-level block
   * must also delete its 1:1 entity row, the same way a doomed service frame's account-owned
   * service is reclaimed — otherwise the row survives as a phantom in the snapshot with its
   * slug reserved forever. Absent → no initiatives exist, so nothing to clean up.
   */
  initiativeRepository?: InitiativeRepository
  /**
   * Document projections, present only when the document-source integration is wired. Backs the
   * same cascade: a document attached to a doomed block keeps a `linked_block_id` naming it
   * unless the delete clears it, and a document row holds exactly ONE such link, so the stale
   * value makes the document look permanently spoken for by a task nobody can open. Absent → the
   * integration is unwired, so no document can be attached to anything.
   */
  documentRepository?: DocumentRepository
  /**
   * Imported tracker issues, present only when the task-source integration is wired. Backs the
   * same cascade for the OTHER table keyed by a single `linked_block_id`: an issue filed as a
   * doomed block keeps a link naming it unless the delete clears it, and three readers take that
   * link to mean "spoken for", so the stale value takes the ticket out of circulation for good
   * (excluded from intake forever, and every future filing of it refused). Absent → the
   * integration is unwired, so no issue can be filed as anything.
   */
  taskRepository?: TaskRepository
  /**
   * Real-time push. When wired, every successful board mutation emits a coarse
   * {@link ExecutionEventPublisher.boardChanged} so OTHER users active on the workspace
   * (and every board mounting a shared service) see the create/rename/move/reparent/delete
   * live instead of only on the next refresh. Best-effort: a publish failure never fails the
   * mutation (the REST response already carried it, and clients reconcile on reconnect).
   * Absent (tests / no real-time transport) → mutations behave exactly as before.
   */
  executionEventPublisher?: ExecutionEventPublisher
  /**
   * The app-owned custom task-type registry. When wired, a task created with a CUSTOM
   * (deployment-registered) namespaced `taskType` resolves its default pipeline through the
   * registry (after the built-in type map), so a proprietary work item can pin its own
   * pipeline. Absent (tests / no custom types) ⇒ only the built-in type defaults apply.
   */
  taskTypeRegistry?: TaskTypeRegistry
  /**
   * Which registered custom task types the ACTING workspace hides (a reusable operation an admin
   * suppressed; `backend/docs/reusable-operations.md`). Wired ⇒ creating a task of a suppressed
   * type is refused server-side, so no door bypasses the picker the suppression removed it from.
   * Absent (tests / an unwired facade) ⇒ nothing is suppressed, today's behaviour.
   */
  taskTypeSuppressionRepository?: TaskTypeSuppressionRepository
  /**
   * Where a new task's per-TASK-TYPE default fragment ids are read from: the app-owned source (this
   * deployment's registry, or the mothership's on a mothership-mode node). Absent ⇒ a new task
   * carries only its explicit/service picks and a registered type's own standing context.
   */
  promptFragmentSource?: PromptFragmentSource
  /**
   * The acting workspace's runtime settings, read by two collaborators:
   *  - the opt-in review-debt friction guard on task creation
   *    (`backend/docs/review-debt-friction.md`) — with this AND
   *    {@link reviewFrictionNotifications} wired and the workspace's friction enabled,
   *    {@link BoardService.addTask} refuses (or requires acknowledgement for) authoring a new
   *    task while too many tasks sit parked on human review;
   *  - the default test-environment provisioning seed stamped onto a new service frame
   *    ({@link serviceProvisioningDefaults}).
   *
   * Absent (tests / conformance / minimal facades) ⇒ both degrade to pass-throughs and
   * creation behaves exactly as before.
   */
  workspaceSettings?: WorkspaceSettingsReader
  reviewFrictionNotifications?: ReviewFrictionNotificationReader
  /**
   * Where the best-effort settings read reports a swallowed failure. Absent ⇒ `noopLogger`
   * (the standalone-unit-test shape); `CoreDependencies.logger` is required, so every facade
   * supplies a real one.
   */
  logger?: Logger
  /**
   * The run-repo seam (checkout-free {@link RepoFiles} bound to the repo a block's run targets).
   * Wired whenever a VCS provider is connected; used at task creation to validate a `review`
   * task's target pull request against the very repo its review will run against. Absent ⇒ the
   * target is taken on trust, exactly as before.
   */
  resolveRunRepoContext?: ResolveRunRepoContext
  /**
   * The workspace's merge-threshold preset library, read by the preset-SELECTION guard: a task's
   * `riskPolicyId` decides which roles its runs sandbox and how their auto-merge is narrowed
   * (ADR 0037), so re-pointing a task is a policy decision, not a preference.
   *
   * Absent is not a hole to guard. With no preset library there is nothing for a task to point
   * at: every task resolves the built-in `FALLBACK_RISK_POLICY`, whose role layer is empty and
   * therefore holds nobody to anything, so the guard is VACUOUS rather than skipped: the same
   * answer it gives on a workspace whose presets treat every initiator alike.
   */
  riskPolicyRepository?: RiskPolicyRepository
}

// The board-changed reason vocabulary lives in `board.logic.ts` (pure, and shared with the
// layout writes extracted from this service); re-exported here so existing importers are
// unaffected.
export type { BoardChangeReason } from './board.logic.js'
import type { BoardChangeReason } from './board.logic.js'

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
  private readonly repoProjectionCache?: GroupCacheHandle<GitHubRepo[]>
  private readonly serviceRepository?: ServiceRepository
  private readonly workspaceMountRepository?: WorkspaceMountRepository
  private readonly serviceFragmentDefaultsRepository?: ServiceFragmentDefaultsRepository
  private readonly initiativeRepository?: InitiativeRepository
  private readonly documentRepository?: DocumentRepository
  private readonly taskRepository?: TaskRepository
  private readonly events?: ExecutionEventPublisher
  private readonly taskTypeRegistry?: TaskTypeRegistry
  private readonly workspaceSettings?: WorkspaceSettingsReader
  private readonly resolveRunRepoContext?: ResolveRunRepoContext
  private readonly log: Logger
  private readonly reviewFrictionGuard: ReviewFrictionGuard
  /** The external `/api/v1` board surface (see publicBoardReads.ts). */
  private readonly publicReads: PublicBoardReads
  /**
   * The headless `internal` anchor blocks a public-API run hangs off (see internalAnchors.ts).
   * Never board state: no event announces one, and every projection filters it out.
   */
  private readonly internalAnchors: ReturnType<typeof createInternalAnchors>
  /**
   * The board's LAYOUT writes — drag a container to a new spot, drag its border to new bounds
   * (see layoutWrites.ts). Both split their write between a frame's per-board mount override and
   * the shared block row, and `resizeBlock` layers the child translation on top of that.
   */
  private readonly layout: ReturnType<typeof createBoardLayoutWrites>
  /**
   * The read half of that same frame-geometry split (see mountProjection.ts): resolve this board's
   * mount for a frame, and project it onto anything a mutation hands back.
   */
  private readonly mountProjection: ReturnType<typeof createMountProjection>
  /**
   * What a new task's TYPE implies for the row `addTask` writes (see taskTypeCreationDefaults.ts):
   * the fragment set it owns from creation, and the pipeline its Run controls default to.
   */
  private readonly taskTypeDefaults: TaskTypeCreationDefaults
  private readonly patchNarrowing: BlockPatchNarrowing
  /**
   * Refuses a task's merge-preset selection that would relax what the EDITOR's own role is held
   * to (ADR 0037). Lives on the service rather than in a controller so every door enforces it:
   * `riskPolicyId` is writable at creation and by patch, and the escape hatch is whichever of
   * those a caller reaches for.
   */
  private readonly riskPolicySelection: RiskPolicySelectionGuard

  constructor({
    workspaceRepository,
    blockRepository,
    executionRepository,
    idGenerator,
    clock,
    repoProjectionRepository,
    repoProjectionCache,
    serviceRepository,
    workspaceMountRepository,
    serviceFragmentDefaultsRepository,
    initiativeRepository,
    documentRepository,
    taskRepository,
    executionEventPublisher,
    taskTypeRegistry,
    taskTypeSuppressionRepository,
    promptFragmentSource,
    workspaceSettings,
    reviewFrictionNotifications,
    resolveRunRepoContext,
    riskPolicyRepository,
    logger,
  }: BoardServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.repoProjectionRepository = repoProjectionRepository
    this.repoProjectionCache = repoProjectionCache
    this.serviceRepository = serviceRepository
    this.workspaceMountRepository = workspaceMountRepository
    this.serviceFragmentDefaultsRepository = serviceFragmentDefaultsRepository
    this.initiativeRepository = initiativeRepository
    this.documentRepository = documentRepository
    this.taskRepository = taskRepository
    this.events = executionEventPublisher
    this.taskTypeRegistry = taskTypeRegistry
    this.workspaceSettings = workspaceSettings
    this.resolveRunRepoContext = resolveRunRepoContext
    this.log = (logger ?? noopLogger).child({ service: 'board' })
    this.reviewFrictionGuard = new ReviewFrictionGuard({
      clock,
      settings: workspaceSettings,
      notifications: reviewFrictionNotifications,
    })
    this.mountProjection = createMountProjection({
      serviceRepository,
      workspaceMountRepository,
    })
    this.taskTypeDefaults = createTaskTypeCreationDefaults({
      taskTypeRegistry,
      promptFragmentSource,
      taskTypeSuppressionRepository,
      logger: this.log,
    })
    this.riskPolicySelection = createRiskPolicySelectionGuard({ riskPolicyRepository })
    // Bound callbacks rather than the service, so the narrowing depends on the two reads and the
    // one validator it actually uses instead of on everything `BoardService` can do.
    this.patchNarrowing = createBlockPatchNarrowing({
      listByWorkspace: (homeWorkspaceId) => blockRepository.listByWorkspace(homeWorkspaceId),
      // The cross-home resolve is BEST-EFFORT here on purpose: an id that cannot be reached is
      // not yet a refusal, it is simply absent from the universe the validators then judge
      // against, which is what produces the specific "not a connection neighbor" message.
      resolveForeign: (workspaceId, id) =>
        this.resolveBlock(workspaceId, id).then(
          (found) => found.block,
          () => null,
        ),
      validatedFields: (taskType, fields) =>
        this.taskTypeDefaults.validatedFields(taskType, fields),
    })
    this.layout = createBoardLayoutWrites({
      blockRepository,
      workspaceMountRepository,
      requireWorkspace: (workspaceId) => this.requireWorkspace(workspaceId),
      resolveBlock: (workspaceId, id) => this.resolveBlock(workspaceId, id),
      frameMount: (workspaceId, block) => this.frameMount(workspaceId, block),
      projectForWorkspace: (workspaceId, block) => this.projectForWorkspace(workspaceId, block),
      emitBoardChanged: (originWorkspaceId, change) =>
        this.emitBoardChanged(originWorkspaceId, change),
    })
    this.publicReads = new PublicBoardReads({
      blockRepository,
      requireWorkspace: (workspaceId) => this.requireWorkspace(workspaceId),
      addTask: (workspaceId, containerId, input, editor, createdBy) =>
        this.addTask(workspaceId, containerId, input, editor, createdBy),
    })
    this.internalAnchors = createInternalAnchors({
      blockRepository,
      idGenerator,
      requireWorkspace: (workspaceId) => this.requireWorkspace(workspaceId),
    })
  }

  /**
   * Push a board-changed signal for a successful mutation. `originWorkspaceId` MUST be
   * the workspace that physically HOMES the affected block (its `homeWorkspaceId`), not
   * necessarily the acting workspace: {@link FanOutEventPublisher} resolves the block's service
   * (and thus every workspace that mounts it) by looking the block up under this origin, so
   * passing a mounter's id for a block homed elsewhere would find nothing and collapse the
   * fan-out to that one board. Naming a block lets the change reach every mount; name none for
   * a signal that should reach the origin workspace only (e.g. a per-workspace frame-layout
   * move). Best-effort: swallow any failure so a missed push never fails the already-persisted
   * mutation, since the client reconciles by re-fetching its snapshot.
   *
   * Pass `block` (rather than only `blockId`) when the change is FULLY described by that one
   * block, so subscribers patch it in place instead of re-reading the whole board. That is the
   * difference between a spawned task costing one small payload and costing a snapshot on every
   * open board. Withhold it for a structural change whose new shape a single block cannot state:
   * a removal or a reparent moves a block BETWEEN parents, and a cascade touches rows the event
   * never names. A frame payload is dropped at the wire by `deliverableBoardBlock`, so naming one
   * here is safe but pointless.
   *
   * When `originConnectionId` is given (a user-driven mutation: move / reparent / field edit,
   * carrying the acting tab's connection id), the realtime transport SKIPS delivering this
   * echo back to that connection: its REST response already carried the authoritative result,
   * so refreshing off its own event would only race an in-flight drag (snapping a block back to
   * a stale position) or trigger a redundant board-wide re-hydrate on every inspector edit. Every
   * OTHER subscriber still receives the signal. Engine-driven board changes pass no origin id, so
   * they fan out to everyone as before.
   */
  private async emitBoardChanged(
    originWorkspaceId: string,
    change: BoardChange & { reason: BoardChangeReason },
  ): Promise<void> {
    try {
      await this.events?.boardChanged(originWorkspaceId, change)
    } catch {
      // best-effort; the REST response already carried the mutation
    }
  }

  /**
   * Everything a NEW service frame inherits from its workspace (default fragments + default
   * test-environment provisioning). Thin delegate to the collaborator that owns the seams and
   * the best-effort reads — see {@link resolveNewServiceFrameDefaults}.
   */
  private newFrameDefaults(workspaceId: string): Promise<NewServiceFrameDefaults> {
    return resolveNewServiceFrameDefaults(workspaceId, {
      settings: this.workspaceSettings,
      serviceFragmentDefaults: this.serviceFragmentDefaultsRepository,
      logger: this.log,
    })
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

  /** @see createMountProjection — THIS board's layout override for a service frame, else null. */
  private frameMount(workspaceId: string, block: Block): Promise<WorkspaceMount | null> {
    return this.mountProjection.frameMount(workspaceId, block)
  }

  /** @see createMountProjection — project a mutation response onto THIS board. */
  private projectForWorkspace(workspaceId: string, block: Block): Promise<Block> {
    return this.mountProjection.projectForWorkspace(workspaceId, block)
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
    const { serviceFragmentIds, provisioning } = await this.newFrameDefaults(workspaceId)
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
      ...(provisioning ? { provisioning } : {}),
    }
    const serviceId = await this.registerService(workspaceId, block)
    await this.blockRepository.insert(workspaceId, block, serviceId)
    // A service FRAME, so no payload: its position is the per-board mount, not this row.
    await this.emitBoardChanged(workspaceId, { reason: 'block-added', blockId: block.id })
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
      // The monorepo flag decides whether `resolveRepoTarget` hands agents the service
      // subdirectory, so drop the cached projection or a warmed entry keeps serving the
      // old flag until its TTL — the agent would run at the repo root instead of the pin.
      await this.repoProjectionCache?.invalidateGroup(workspaceId)
    }
    // Normalise the requested service subdirectory to a clean, SAFE relative path:
    // strip slashes/`.` and reject any `..` segment, so a stored directory can never
    // point an agent's cwd outside the checkout (the harness enforces the same — this
    // is defence in depth, and surfaces a clean error before the row is written).
    const directory = normalizeServiceDirectory(input.directory)
    // A monorepo can back SEVERAL service frames (one per subdirectory), so the
    // single-service guard applies only to whole-repo (non-monorepo) repos. A monorepo
    // service MUST name its subdirectory so execution can scope agents to it. The link
    // is the account-owned Service, so a duplicate is detected via `getByRepo`.
    if (!repo.isMonorepo && this.serviceRepository) {
      // Dedup ACCOUNT-scoped (not just same-installation): a service is account-owned and shared
      // across the org's boards, so an existing whole-repo service for this repo anywhere in the
      // account must be MOUNTED here — not duplicated by minting a rival (which could happen if two
      // boards reach the repo through different installations). Mounting gives both boards one
      // shared subtree + task list (composeBoard); idempotent when already on this board. Monorepos
      // are exempt — each subdirectory is its own service (handled by the directory guard below).
      const existing = await this.findAccountWholeRepoService(workspaceId, repo.githubId)
      if (existing) {
        return this.mountExistingService(workspaceId, existing, input.position)
      }
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
    const { serviceFragmentIds, provisioning } = await this.newFrameDefaults(workspaceId)
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
      ...(provisioning ? { provisioning } : {}),
    }
    const serviceId = await this.registerService(workspaceId, block, {
      installationId: repo.installationId,
      githubId: repo.githubId,
      directory: directory ?? null,
    })
    await this.blockRepository.insert(workspaceId, block, serviceId)
    // A service FRAME, so no payload (see `addBlock`).
    await this.emitBoardChanged(workspaceId, { reason: 'block-added', blockId: block.id })
    return block
  }

  /**
   * The account's existing WHOLE-REPO (non-monorepo, no subdirectory) service for a repo, or null.
   * Account-scoped so it dedups a shared repo across the org regardless of which installation each
   * board reached it through. Requires the service repo to be wired.
   */
  private async findAccountWholeRepoService(
    workspaceId: string,
    repoGithubId: number,
  ): Promise<Service | null> {
    if (!this.serviceRepository) return null
    const account = (await this.workspaceRepository.accountOf(workspaceId)) ?? null
    const services = await this.serviceRepository.listByAccount(account)
    return services.find((s) => s.repoGithubId === repoGithubId && !s.directory) ?? null
  }

  /**
   * Mount an EXISTING account-owned service onto `workspaceId` and return its frame block —
   * the shared-service path taken by {@link addServiceFromRepo} when the repo already backs a
   * service. Mounting (not re-creating) is how two boards in one org work on the same service
   * with a shared subtree/task list. Same-org only; idempotent when already mounted here.
   */
  private async mountExistingService(
    workspaceId: string,
    service: Service,
    position?: { x: number; y: number },
  ): Promise<Block> {
    if (!this.workspaceMountRepository) {
      throw new ValidationError('This repository is already linked to a board service')
    }
    // A service is shared strictly within its account — never mount one from another org.
    const account = await this.workspaceRepository.accountOf(workspaceId)
    if ((account ?? null) !== (service.accountId ?? null)) {
      throw new ValidationError(
        'This repository is already linked to a service in another organization',
      )
    }
    const home = await this.blockRepository.findById(service.frameBlockId)
    if (!home) {
      // The service's frame block is gone (a stale orphan). Surface a clean error rather than
      // mounting a dead frame; the delete cascade normally reclaims such orphans.
      throw new ValidationError('This repository is already linked to a board service')
    }
    let mount = await this.workspaceMountRepository.get(workspaceId, service.id)
    if (!mount) {
      const existingMounts = await this.workspaceMountRepository.listByWorkspace(workspaceId)
      // Lay a new mount out on a 5-wide grid (matching ServiceMountService) when no explicit
      // position is given, so shared services don't pile onto the same point.
      const n = existingMounts.length
      mount = {
        workspaceId,
        serviceId: service.id,
        position: position ?? { x: 80 + (n % 5) * 48, y: 80 + Math.floor(n / 5) * 48 },
        size: null,
        createdAt: this.clock.now(),
      }
      await this.workspaceMountRepository.upsert(mount)
      // Fan out from the frame's HOME so every board mounting the shared service refreshes. A
      // FRAME, and each target board reads its own mount, so there is no payload to carry.
      await this.emitBoardChanged(home.workspaceId, {
        reason: 'block-added',
        blockId: home.block.id,
      })
    }
    // The frame block is the one homed on ANOTHER board, carrying that board's coordinates —
    // return it placed where THIS board just mounted it, or the SPA drops the imported service
    // at the home board's spot until the next full refresh.
    return applyMountLayout(home.block, mount)
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

  /**
   * Add a task inside a container (a service frame or a module).
   *
   * `editor` is who is creating it, for the merge-preset selection guard: authoring a task
   * straight onto a permissive preset moves it off the workspace default that would otherwise
   * have governed it, so creation is the same decision as a later swap and takes the same check.
   * Pass `UNATTRIBUTED_BLOCK_EDITOR` for a caller with no workspace tier (see its doc).
   */
  async addTask(
    workspaceId: string,
    containerId: string,
    input: AddTaskInput,
    editor: BlockEditActor,
    createdBy?: string | null,
  ): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    // Before any side effect, and against the workspace default: a task does not exist yet, so
    // the policy this creation is moving AWAY from is the one it would have resolved unpicked.
    await this.riskPolicySelection.assertMaySelect({
      workspaceId,
      actor: editor,
      currentId: null,
      nextId: input.riskPolicyId,
    })
    // The container may be a frame/module of a service mounted from another workspace; create
    // the task in that service's home workspace so it joins the one shared subtree.
    const { homeWorkspaceId, block: container } = await this.resolveBlock(workspaceId, containerId)
    if (container.level === 'task') {
      throw new ValidationError('Tasks cannot contain other tasks')
    }
    // The SAME containment rule reparent enforces, applied at CREATE: a task may only live under
    // a service frame or a module. An `epic`/`initiative` is a grouping node that tasks join via
    // their `epicId`/`initiativeId` membership link, never by parentage — and a task parented to
    // one would be invisible to every reader that resolves the subtree structurally (the public
    // API's `listServiceTasks`), so let the create fail here rather than silently orphan it.
    if (!canReparent('task', container)) {
      throw new ValidationError(`A task cannot be placed inside a ${container.level}`)
    }
    const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
    // Opt-in review-debt friction: refuse (or require acknowledgement for) authoring a new task
    // while too many tasks sit parked on human review. Runs in the ACTING workspace's context
    // (its settings + its open notifications) before any side effect; `blocks` supplies the debt
    // titles with no extra query. Pass-through when the seams are unwired or friction is off.
    await this.reviewFrictionGuard.assertAllows(
      workspaceId,
      blocks,
      input.acknowledgeReviewDebt === true,
    )
    const siblings = tasksOf(blocks, containerId).length
    const service = serviceOf(blocks, container)
    const taskType = input.taskType ?? 'feature'
    this.assertTaskTypeAllowed(service, taskType)
    // A reusable operation a workspace admin HID is refused here, not only kept out of the picker:
    // the internal API, the public API, an initiative spawn and a tracker import all reach this
    // method without ever seeing one. Runs in the ACTING workspace's context, like the friction
    // guard above, and before any side effect.
    await this.taskTypeDefaults.assertNotSuppressed(workspaceId, taskType)
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
    // Small per-type form fields (bug severity / repro, spike timebox, …), when given. A registered
    // custom type's `custom` bag is CHECKED against its descriptor here rather than trusted from the
    // form, so every door (SPA, internal API, public API) enforces one rule; see
    // `taskTypeCreationDefaults.ts` for what passes through unchecked and why.
    const submittedFields = this.taskTypeDefaults.validatedFields(taskType, input.taskTypeFields)
    if (submittedFields && Object.keys(submittedFields).length) {
      block.taskTypeFields = submittedFields
    }
    // A REVIEW task targets an EXISTING pull request, so its reference is checked against the
    // provider BEFORE the block is written: a PR the provider positively reports as absent fails
    // here rather than as a dispatched run with nothing to review. The confirmed PR's own web url
    // replaces whatever was typed, which is what the inspector links (see
    // {@link resolveReviewTaskTarget} for the pass-through cases).
    block.taskTypeFields = await resolveReviewTaskTarget(
      { resolveRunRepoContext: this.resolveRunRepoContext, logger: this.log },
      homeWorkspaceId,
      containerId,
      taskType,
      block.taskTypeFields,
    )
    // Fold the (now canonical) PR reference + focus into the description, so the read-only
    // `pr-reviewer` knows WHICH PR to review from its prompt.
    block.description = buildReviewDescription(taskType, block.taskTypeFields, block.description)
    // The best-practice fragments the task OWNS from creation: the create form's picks or the
    // service's standing standards, unioned with the type's defaults, a registered operation's
    // standing context, and whichever of its CONDITIONAL entries hold against the values collected
    // above. Derived by `taskTypeCreationDefaults.ts`, which owns the precedence rules and STATES a
    // custom type this process does not register.
    //
    // `block.taskTypeFields` and not `input.taskTypeFields`: the fields have been validated and
    // SANITIZED by now, so a value for a field hidden by its own `showWhen` is already gone, and a
    // conditional rule keyed on one must reduce to false to match what the row actually freezes.
    const fragmentIds = await this.taskTypeDefaults.fragmentIdsFor({
      taskType,
      explicit: input.fragmentIds,
      serviceFragmentIds: service?.serviceFragmentIds,
      // `?? undefined` because the row spells "no per-case values" as null while the reduction
      // takes an absent bag. Both mean the same thing to it: no conditional entry holds.
      fields: block.taskTypeFields ?? undefined,
    })
    if (fragmentIds.length) {
      block.fragmentIds = fragmentIds
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
    if (input.riskPolicyId) block.riskPolicyId = input.riskPolicyId
    if (input.modelPresetId) block.modelPresetId = input.modelPresetId
    // Pin the chosen pipeline, else fall back to the task type's own default (see
    // `taskTypeCreationDefaults.ts`); absent, the run-time picker's positional default applies.
    if (input.pipelineId) block.pipelineId = input.pipelineId
    else {
      const typeDefault = this.taskTypeDefaults.pipelineIdFor(taskType)
      if (typeDefault) block.pipelineId = typeDefault
    }
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
    // the fan-out reaches every workspace mounting the service, not just the acting one. A new
    // task is fully described by itself, so it rides along and every board patches it in place
    // rather than re-reading a snapshot: this is the event an initiative loop fires per spawn.
    await this.emitBoardChanged(homeWorkspaceId, { reason: 'block-added', block })
    return block
  }

  // --- Headless internal anchors ---------------------------------------------
  // Delegated to {@link createInternalAnchors}: the top-level `internal: true` blocks that anchor
  // a public-API run and render on no board, ever. See that file for why the four belong together.

  /** Public-API: create the anchor block a public-API run hangs off. */
  createInternalTask(
    workspaceId: string,
    input: { title: string; description: string },
  ): Promise<Block> {
    return this.internalAnchors.createInternalTask(workspaceId, input)
  }

  /** Public-API: an anchor by id, or null when the block is absent or not `internal`. */
  getInternalTask(workspaceId: string, blockId: string): Promise<Block | null> {
    return this.internalAnchors.getInternalTask(workspaceId, blockId)
  }

  /** Public-API: roll an anchor back when the run it was created for fails to start. */
  deleteInternalTask(workspaceId: string, blockId: string): Promise<void> {
    return this.internalAnchors.deleteInternalTask(workspaceId, blockId)
  }

  /** Public-API: how many anchored runs are in flight — the concurrency backstop. */
  countActiveInternalTasks(workspaceId: string): Promise<number> {
    return this.internalAnchors.countActiveInternalTasks(workspaceId)
  }

  // --- Public-API board reads/writes -----------------------------------------
  // Delegated to {@link PublicBoardReads}: the external `/api/v1` surface is its own cohesive
  // collaborator because the whole group shares a contract the rest of the board does not — a
  // key's OWN workspace only, keyed on the frame block id, headless `internal` anchors always
  // excluded. See that file for the scoping rationale on each read.

  /** Public-API: the workspace's board services (visible service frames). */
  listServices(workspaceId: string): Promise<Block[]> {
    return this.publicReads.listServices(workspaceId)
  }

  /** Public-API: create a task under a visible service frame the workspace owns. */
  addServiceTask(
    workspaceId: string,
    serviceId: string,
    input: AddTaskInput,
    editor: BlockEditActor,
  ): Promise<Block> {
    return this.publicReads.addServiceTask(workspaceId, serviceId, input, editor)
  }

  /** Public-API: refuse a service frame that cannot hold a new task, before doing work for one. */
  assertTaskContainer(workspaceId: string, serviceId: string): Promise<Block> {
    return this.publicReads.assertTaskContainer(workspaceId, serviceId)
  }

  /** Public-API: a board task + its enclosing service frame; null when not externally visible. */
  getServiceTask(
    workspaceId: string,
    taskId: string,
  ): Promise<{ block: Block; service: Block } | null> {
    return this.publicReads.getServiceTask(workspaceId, taskId)
  }

  /** Public-API: one bounded, keyset-paginated page of a service's task subtree. */
  listServiceTasksPage(
    workspaceId: string,
    serviceId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<{ tasks: Block[]; hasMore: boolean } | null> {
    return this.publicReads.listServiceTasksPage(workspaceId, serviceId, opts)
  }

  /** Add a module (sub-frame) inside a service. */
  async addModule(workspaceId: string, serviceId: string, input: AddModuleInput): Promise<Block> {
    const created = await this.addModules(workspaceId, serviceId, [input])
    return created[0]!
  }

  /**
   * Add several modules to a service in ONE pass — resolving the workspace + service and
   * listing the board a single time for the whole batch (module positions lay out against
   * one starting count) instead of paying a workspace list per module as repeated
   * {@link addModule} calls would (a banned N+1 when a reconcile adds many modules at once).
   * Returns the created blocks in input order.
   */
  async addModules(
    workspaceId: string,
    serviceId: string,
    inputs: AddModuleInput[],
  ): Promise<Block[]> {
    await this.requireWorkspace(workspaceId)
    if (inputs.length === 0) return []
    // The service frame may be mounted from another workspace; create the modules in its home.
    const { homeWorkspaceId, block: service } = await this.resolveBlock(workspaceId, serviceId)
    if (service.level !== 'frame') {
      throw new ValidationError('Modules can only be added to a service frame')
    }
    const blocks = await this.blockRepository.listByWorkspace(homeWorkspaceId)
    const containerServiceId = await this.serviceForContainer(blocks, service)
    let n = blocks.filter((b) => b.parentId === serviceId && b.level === 'module').length
    const created: Block[] = []
    for (const input of inputs) {
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
      await this.blockRepository.insert(homeWorkspaceId, block, containerServiceId)
      // Origin = the block's HOME so a module added to a mounted service fans out to all mounts.
      // A module is a sub-frame with no mount of its own, so its payload is correct everywhere.
      await this.emitBoardChanged(homeWorkspaceId, { reason: 'block-added', block })
      created.push(block)
      n += 1
    }
    return created
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
    await this.emitBoardChanged(workspaceId, { reason: 'block-added', block })
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
    // Re-read BEFORE emitting so the event carries the task it just changed: membership is a
    // field ON the task, so the one block states the whole change and subscribers patch it.
    // Origin = the task's HOME so the fan-out resolves the (possibly mounted) service's boards.
    const updated = assertFound(
      await this.blockRepository.get(homeWorkspaceId, taskId),
      'Block',
      taskId,
    )
    await this.emitBoardChanged(homeWorkspaceId, { reason: 'epic-assigned', block: updated })
    return updated
  }

  /** Move a block to a new spot on the board (a frame's position is its per-board override). */
  async moveBlock(
    workspaceId: string,
    id: string,
    position: Position,
    originConnectionId?: string | null,
  ): Promise<Block> {
    return this.layout.moveBlock(workspaceId, id, position, originConnectionId)
  }

  /**
   * Apply the new bounds of a container dragged by one of its borders, translating its contents
   * when the drag moved the content ORIGIN. See `layoutWrites.ts` for why that translation is
   * part of this write rather than a `move` plus an `update`.
   */
  async resizeBlock(
    workspaceId: string,
    id: string,
    bounds: ResizeBlockInput,
    originConnectionId?: string | null,
  ): Promise<Block> {
    return this.layout.resizeBlock(workspaceId, id, bounds, originConnectionId)
  }

  /**
   * Apply a patch to a block. `editor` is who is applying it, for the merge-preset selection
   * guard (see {@link addTask}); pass `UNATTRIBUTED_BLOCK_EDITOR` for a caller with no tier.
   */
  async updateBlock(
    workspaceId: string,
    id: string,
    patch: UpdateBlockInput,
    editor: BlockEditActor,
    originConnectionId?: string | null,
  ): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await this.resolveBlock(workspaceId, id)
    // Re-pointing a task at another merge preset re-decides which roles its runs sandbox and how
    // their auto-merge is narrowed, so it is refused when it would relax what the EDITOR's own
    // role is held to. Before the write, and only when the patch names the field: an untouched
    // `riskPolicyId` is not a selection.
    if (patch.riskPolicyId !== undefined) {
      await this.riskPolicySelection.assertMaySelect({
        workspaceId,
        actor: editor,
        currentId: block.riskPolicyId,
        nextId: patch.riskPolicyId,
      })
    }
    // Each patch field that belongs to a DIFFERENT kind of block than the one addressed is
    // dropped rather than persisted as dead data, and the three that name other entities are
    // validated against them. One collaborator (`blockPatchNarrowing.ts`) owns all of it.
    const narrow = this.patchNarrowing
    let effective = narrow.serviceFragmentIds(patch, block)
    effective = await narrow.serviceConnections(effective, block, id, homeWorkspaceId, workspaceId)
    effective = await narrow.involvedServiceIds(effective, block, homeWorkspaceId, workspaceId)
    effective = narrow.referenceRepos(effective, block)
    effective = narrow.aprioriBranches(effective, block)
    // AFTER both of its inputs have settled: the branch invariants are cross-field, so they read
    // the effective branch list against the effective involved set.
    narrow.aprioriBranchInvariants(effective, block)
    // LAST, because it is the one narrowing that changes the patch's SHAPE: the request names
    // `customTaskTypeFields` (the half that may be patched) and the row stores the whole
    // `taskTypeFields`, so this is where the request type becomes the repository's.
    await this.blockRepository.update(
      homeWorkspaceId,
      id,
      narrow.customTaskTypeFields(effective, block),
    )
    const updated = assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id)
    // Origin = the block's HOME so editing a shared block fans out to every board mounting it.
    // Forward the acting tab's connection id so the realtime transport SKIPS echoing this back to
    // it: the REST response already carried the authoritative block (the SPA upserts it), so a
    // self-echo would only trigger a redundant board-wide re-hydrate, the same "don't refresh off
    // your own mutation" contract move/reparent already follow. Every OTHER subscriber receives
    // the change, carrying the edited block. The UNPROJECTED row is what rides: the projection
    // below is for THIS board, and a fan-out reaches boards with different mounts. That only ever
    // matters for a frame, whose payload `deliverableBoardBlock` drops at the wire anyway.
    await this.emitBoardChanged(homeWorkspaceId, {
      reason: 'block-updated',
      block: updated,
      originConnectionId,
    })
    // A frame's position/size come from THIS board's mount, not the row we just re-read, so a
    // frame edit (rename, threshold, and above all a RESIZE) must not hand the SPA the block's
    // own, never-updated coordinates to upsert.
    return this.projectForWorkspace(workspaceId, updated)
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
    // The declared module follows the destination container, for the same reason the type follows
    // the destination frame: both are facts about where the task now lives, not about the task.
    // Left alone, a task dragged out of a module keeps naming it, and the board's fallback (the
    // declared name, for a task whose module block does not exist yet) files the card straight
    // back under the module it was just dragged out of. `moduleNameInContainer` is the rule the
    // SPA predicts the same answer from. Empty clears the column, like every other clearable field.
    const movedModule =
      block.level === 'task' ? moduleNameInContainer(parent) : (block.moduleName ?? '')

    // Same physical home (the common case, incl. two of the workspace's own services): move in
    // place and re-stamp `service_id`, the physical scope key that decides which boards render
    // the subtree and where its events fan out. No-op re-stamp when sharing isn't wired or the
    // destination frame isn't a registered service.
    if (blockHome === parentHome) {
      await this.blockRepository.update(blockHome, id, {
        parentId: input.parentId,
        position: input.position,
        ...(movedType !== block.type ? { type: movedType } : {}),
        ...(movedModule !== (block.moduleName ?? '') ? { moduleName: movedModule } : {}),
      })
      if (this.serviceRepository) {
        const destService = await this.serviceForContainer(destBlocks, parent)
        await this.blockRepository.setService(
          blockHome,
          [...descendantIds(destBlocks, id)],
          destService ?? null,
        )
      }
      // Origin = the block's HOME so the re-stamped subtree fans out to every mounting board. No
      // payload: a reparent moves the whole SUBTREE between parents, and the moved block alone
      // cannot state what its descendants' service stamps became.
      await this.emitBoardChanged(blockHome, {
        reason: 'block-reparented',
        blockId: id,
        originConnectionId,
      })
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
          ? {
              ...b,
              parentId: input.parentId,
              position: input.position,
              type: movedType,
              moduleName: movedModule,
            }
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
    await pruneDanglingEdges(this.blockRepository, blockHome, srcBlocks, new Set(ids))
    // Destination side: origin = the new HOME so the moved subtree fans out to the destination
    // service's mounts (and that board). Source side: the block is gone from its old service, so
    // the block→service join can't resolve it anymore — notify the captured source boards
    // directly (origin-only) so they refresh the subtree away.
    await this.emitBoardChanged(parentHome, {
      reason: 'block-reparented',
      blockId: id,
      originConnectionId,
    })
    for (const ws of sourceFanout) {
      if (ws !== parentHome) {
        await this.emitBoardChanged(ws, { reason: 'block-reparented', originConnectionId })
      }
    }
    return assertFound(await this.blockRepository.get(parentHome, id), 'Block', id)
  }

  /**
   * Delete a block and all its descendants, dropping dangling dependencies.
   *
   * `opts.preloaded` lets the caller hand in a block list it already loaded (the delete
   * path's teardown lists the board immediately before this) so a locally-owned delete
   * doesn't re-list the whole board; it is reused ONLY when it was loaded for the same
   * workspace this block homes to (a mounted shared service homed elsewhere re-lists).
   */
  async removeBlock(
    workspaceId: string,
    id: string,
    opts: { preloaded?: PreloadedBlocks } = {},
  ): Promise<void> {
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
    // Reuse the caller's list only when it was loaded for this block's home (the common
    // locally-owned delete); a mounted service homed elsewhere re-lists against its home.
    const blocks =
      opts.preloaded && opts.preloaded.workspaceId === homeWorkspaceId
        ? opts.preloaded.blocks
        : await this.blockRepository.listByWorkspace(homeWorkspaceId)
    const doomed = descendantIds(blocks, id)

    // A service frame that still has unfinished work must NOT be deleted (that would discard
    // in-flight tasks + their history) — it is archived instead (hidden, restorable with no
    // expiry). Only guard a real, still-present top-level frame: a dangling/already-gone id
    // (idempotent re-delete, a leaf task, a module) falls through to the normal cleanup below.
    const target = blocks.find((b) => b.id === id)
    if (target?.level === 'frame' && target.parentId === null) {
      const unfinished = unfinishedTasksUnder(blocks, id)
      if (unfinished.length > 0) {
        throw new ValidationError(
          `This service has ${unfinished.length} unfinished task(s); archive it instead of deleting.`,
        )
      }
    }

    await this.executionRepository.deleteByBlock(homeWorkspaceId, id)
    // Every SIDE-TABLE row keyed by a doomed block id — the account-owned service + its mounts,
    // and the initiative entity. Extracted to its own module (see `removal-cascade.ts`): each is
    // an optional, batched reclaim, and this is where the delete path grows, so a future
    // block-keyed table gets a section there rather than another branch in this method.
    await reclaimDoomedEntities(
      {
        ...(this.serviceRepository ? { serviceRepository: this.serviceRepository } : {}),
        ...(this.workspaceMountRepository
          ? { workspaceMountRepository: this.workspaceMountRepository }
          : {}),
        ...(this.initiativeRepository ? { initiativeRepository: this.initiativeRepository } : {}),
        ...(this.documentRepository ? { documentRepository: this.documentRepository } : {}),
        ...(this.taskRepository ? { taskRepository: this.taskRepository } : {}),
      },
      { homeWorkspaceId, deletedId: id, blocks, doomed },
    )
    await this.blockRepository.deleteMany(homeWorkspaceId, [...doomed])

    await pruneDanglingEdges(this.blockRepository, homeWorkspaceId, blocks, doomed)

    // The block + any shared service are now gone, so fan out per captured target (blockId is
    // unresolvable post-delete): every board that showed the block refreshes it away. There is
    // nothing to carry, and a delete CASCADES, so the refresh is the point.
    for (const ws of fanoutTargets) {
      await this.emitBoardChanged(ws, { reason: 'block-removed' })
    }
  }

  /**
   * Archive a service frame: hide it (and its whole subtree) from the board projection while
   * preserving every row, so it can be restored later with no expiry. This is the non-destructive
   * alternative to {@link removeBlock} for a service that still has unfinished work. Only a
   * top-level service frame can be archived (tasks/modules are hidden with their frame); a
   * non-frame target is rejected. Fans out to every board mounting a shared service.
   */
  async archiveBlock(workspaceId: string, id: string): Promise<Block> {
    return this.setArchived(workspaceId, id, true)
  }

  /** Restore an archived service frame back onto the board. The inverse of {@link archiveBlock}. */
  async restoreBlock(workspaceId: string, id: string): Promise<Block> {
    return this.setArchived(workspaceId, id, false)
  }

  private async setArchived(workspaceId: string, id: string, archived: boolean): Promise<Block> {
    await this.requireWorkspace(workspaceId)
    const { homeWorkspaceId, block } = await this.resolveBlock(workspaceId, id)
    if (block.level !== 'frame' || block.parentId !== null) {
      throw new ValidationError('Only a service can be archived')
    }
    await this.blockRepository.update(homeWorkspaceId, id, { archived })
    // Origin = the block's HOME so archiving a shared service fans out to every board mounting it.
    // Always a FRAME (asserted above) and archiving hides its whole subtree, so no payload.
    await this.emitBoardChanged(homeWorkspaceId, {
      reason: archived ? 'block-archived' : 'block-restored',
      blockId: id,
    })
    // Always a frame (asserted above), so it owes the caller this board's layout override.
    return this.projectForWorkspace(
      workspaceId,
      assertFound(await this.blockRepository.get(homeWorkspaceId, id), 'Block', id),
    )
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
    // Re-read first so the event carries the target: `dependsOn` lives on it, so one block
    // states the whole change (the SOURCE block is untouched).
    const updated = assertFound(
      await this.blockRepository.get(homeWorkspaceId, targetId),
      'Block',
      targetId,
    )
    await this.emitBoardChanged(homeWorkspaceId, { reason: 'dependency-toggled', block: updated })
    return updated
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
