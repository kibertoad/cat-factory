import type { CreateWorkspaceInput } from '@cat-factory/contracts'
import {
  applyMountLayout,
  describeError,
  FINAL_SPEND_FOLD_BUDGET_MS,
  finalSpendFoldPlan,
  getErrorMessage,
  noopLogger,
  offeredPipelines,
  registerServiceForFrame,
  requireWorkspace,
  retiredPipelines,
  riskPolicySeedRows,
  runBestEffort,
  seedBlocks,
  seedModelPresets,
  seedPipelines,
  seedRiskPolicies,
} from '@cat-factory/kernel'
import type {
  Block,
  ExecutionInstance,
  LogFields,
  Logger,
  SpendFoldSpan,
  Workspace,
  WorkspaceAccessRow,
  WorkspaceMount,
  WorkspaceRole,
  WorkspaceSnapshot,
} from '@cat-factory/kernel'
import type {
  BlockRepository,
  EnvironmentHandlerSeeder,
  SharedStackSeeder,
  ExecutionRepository,
  GroupCacheHandle,
  PipelineRegistry,
  PipelineRepository,
  ResolveBinaryArtifactStore,
  RiskPolicyRepository,
  ServiceRehome,
  ServiceRepository,
  SpendRollupRepository,
  WorkspaceAccessCacheValue,
  WorkspaceMemberRepository,
  WorkspaceMountRepository,
  WorkspaceRepository,
  WorkspaceVisibility,
} from '@cat-factory/kernel'
import type { Clock, IdGenerator } from '@cat-factory/kernel'

export { requireWorkspace } from '@cat-factory/kernel'

/**
 * The one line that reports spend a deleted board took with it. Shared by every way the final
 * fold can come up short so an operator greps ONE message: what separates the causes are the
 * line's FIELDS (`failedSpans` vs `unattemptedSpans`, or `reason` in the one case that has no
 * spans to name because planning them is what failed), not a message per cause. They differ in
 * what an operator should fix, never in what was lost: all of it is permanent the moment the
 * cascade runs.
 */
const UNFOLDED_SPEND_MSG =
  'workspace-delete could not fold all of the board’s remaining spend; ' +
  'that attribution is permanently absent'

/** One span as a compact `[from, to)` pair, so a log field holds spans and not prose. */
const spanPair = (span: SpendFoldSpan): [number, number] => [span.from, span.to]

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
  /**
   * Workspace-level RBAC roster (workspace-rbac initiative). When wired, `create` seeds an
   * admin member row for the creator (auto-enroll) and {@link WorkspaceService.memberRoleOf}
   * resolves a caller's explicit role for the gate. Optional — absent (tests / no member tier)
   * ⇒ auto-enroll is skipped and `memberRoleOf` returns null (resolution falls back to the
   * account tier).
   */
  workspaceMemberRepository?: WorkspaceMemberRepository
  /**
   * The app-owned pipeline registry (deployment-registered extra pipelines). When wired, a new
   * workspace is seeded with the built-in catalog PLUS those extras (and the reseed-version map
   * accounts for them). Optional — absent (tests) ⇒ the built-in catalog only.
   */
  pipelineRegistry?: PipelineRegistry
  /**
   * The workspace's merge-preset library. When wired, `create` seeds the built-in catalog onto a
   * new board, exactly as it seeds the pipeline catalog and for the same reason: which merge
   * policy governs a run is product configuration, and the run path must not have to discover it.
   *
   * It is seeded HERE, on the write, rather than on the first `list()` read, because the engine
   * resolves a task's preset with no read of its own: a workspace whose library nothing had
   * listed yet answered `getDefault` with null, and the run fell through to
   * `FALLBACK_RISK_POLICY`, which auto-merges nothing. Through the SPA that never showed, since
   * loading a board lists the presets; through the public API, which starts runs on boards no
   * browser has opened, it meant the same task merged or did not depending on whether anyone had
   * looked at the board first.
   *
   * Optional so a deployment that wires no preset repository still creates boards. Such a
   * deployment has genuinely configured no merge policy, and its runs report exactly that
   * (`no_policy_configured`) rather than landing pull requests on a model's own scores.
   */
  riskPolicyRepository?: RiskPolicyRepository
  /**
   * The `workspaceAccess` cache slice (workspace-rbac initiative). When wired, a board delete
   * drops the deleted board's whole access GROUP so no stale (grant/denial) entry outlives it —
   * hygiene, since the board id is never reused. Optional — absent (tests / no cache) ⇒ the delete
   * simply skips the invalidation (the gate resolves live). The roster + access-mode write paths
   * (a later slice's member-management service) invalidate the same group on their own writes.
   */
  workspaceAccessCache?: GroupCacheHandle<WorkspaceAccessCacheValue>
  /**
   * Resolves a workspace's binary-artifact store (screenshots + reference images) so a board
   * delete can reclaim their heavy blob bytes. Optional — when unwired (no content storage
   * configured, or in tests) the delete path simply skips the purge. Absent from the
   * `workspaceRepository.delete` cascade on purpose: deleting the metadata row without the
   * bytes would strand the blob forever (the row is the only handle on its key), so the purge
   * runs through this port at the service layer before the cascade.
   */
  resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  /**
   * The durable cost-attribution rollup (`spend_days`). When wired, a board delete folds the
   * board's UN-ROLLED days into it before the cascade takes `token_usage` away, which is the
   * only moment that spend can still be attributed: the table is deliberately outside the
   * cascade, but the sweep that fills it only reaches boards that still exist, so everything
   * since the last completed rollup day would otherwise go with the ledger rows that produced
   * it. Optional: absent (tests / a facade with no reports wiring) ⇒ the delete skips the fold.
   */
  spendRollupRepository?: Pick<
    SpendRollupRepository,
    'rollupWorkspaceSpendDays' | 'spendRollupWatermark'
  >
  /**
   * How long `token_usage` is retained (`TOKEN_USAGE_RETENTION_DAYS`), which bounds how far back
   * that final fold walks: past the ledger's own retention there is nothing left to fold. 0 or
   * absent means the ledger is never pruned, and the fold falls back to its backfill floor. It
   * is the SAME number the retention sweep derives its catch-up horizon from, so a board's last
   * fold covers exactly the days a sweep would have.
   */
  tokenUsageRetentionMs?: number
  /** Optional structural logger for best-effort diagnostics (e.g. a swallowed artifact purge). */
  logger?: Logger
  /**
   * Late-bound (the seeder is built after this service in the container, so it's read at call
   * time — mirrors the `getSpendService` accessor AccountService uses) so `create` seeds the
   * deployment's declared environment handlers onto a new workspace. Absent ⇒ no seeding.
   */
  getEnvironmentHandlerSeeder?: () => EnvironmentHandlerSeeder | undefined
  /**
   * Late-bound the same way, for the same reason: `create` seeds the deployment's declared SHARED
   * STACKS (the long-lived compose infra its previews attach to) onto a new workspace. Absent ⇒
   * no seeding.
   */
  getSharedStackSeeder?: () => SharedStackSeeder | undefined
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
  private readonly workspaceMemberRepository?: WorkspaceMemberRepository
  private readonly pipelineRegistry?: PipelineRegistry
  private readonly riskPolicyRepository?: RiskPolicyRepository
  private readonly workspaceAccessCache?: GroupCacheHandle<WorkspaceAccessCacheValue>
  private readonly resolveBinaryArtifactStore?: ResolveBinaryArtifactStore
  private readonly spendRollupRepository?: Pick<
    SpendRollupRepository,
    'rollupWorkspaceSpendDays' | 'spendRollupWatermark'
  >
  private readonly tokenUsageRetentionMs: number
  private readonly logger?: Logger
  private readonly getEnvironmentHandlerSeeder?: () => EnvironmentHandlerSeeder | undefined
  private readonly getSharedStackSeeder?: () => SharedStackSeeder | undefined

  constructor({
    workspaceRepository,
    blockRepository,
    pipelineRepository,
    executionRepository,
    idGenerator,
    clock,
    serviceRepository,
    workspaceMountRepository,
    workspaceMemberRepository,
    pipelineRegistry,
    riskPolicyRepository,
    workspaceAccessCache,
    resolveBinaryArtifactStore,
    spendRollupRepository,
    tokenUsageRetentionMs,
    logger,
    getEnvironmentHandlerSeeder,
    getSharedStackSeeder,
  }: WorkspaceServiceDependencies) {
    this.workspaceRepository = workspaceRepository
    this.blockRepository = blockRepository
    this.pipelineRepository = pipelineRepository
    this.executionRepository = executionRepository
    this.idGenerator = idGenerator
    this.clock = clock
    this.serviceRepository = serviceRepository
    this.workspaceMountRepository = workspaceMountRepository
    this.pipelineRegistry = pipelineRegistry
    this.riskPolicyRepository = riskPolicyRepository
    this.workspaceMemberRepository = workspaceMemberRepository
    this.workspaceAccessCache = workspaceAccessCache
    this.resolveBinaryArtifactStore = resolveBinaryArtifactStore
    this.spendRollupRepository = spendRollupRepository
    this.tokenUsageRetentionMs = tokenUsageRetentionMs ?? 0
    this.logger = logger
    this.getEnvironmentHandlerSeeder = getEnvironmentHandlerSeeder
    this.getSharedStackSeeder = getSharedStackSeeder
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

  /**
   * The narrow access row workspace-RBAC resolution reads in one hot-path query (owning
   * account, legacy owner, access mode); `undefined` when the board doesn't exist.
   */
  accessRowOf(id: string): Promise<WorkspaceAccessRow | undefined> {
    return this.workspaceRepository.accessRowOf(id)
  }

  /**
   * The caller's explicit `workspace_members` role on a board, or `null` when they hold no
   * row — INCLUDING when the member tier isn't wired (tests / no roster), so resolution
   * cleanly falls back to the account tier.
   */
  async memberRoleOf(workspaceId: string, userId: string): Promise<WorkspaceRole | null> {
    const row = await this.workspaceMemberRepository?.get(workspaceId, userId)
    return row?.role ?? null
  }

  /**
   * The caller's explicit member role in each of `workspaceIds`, in ONE chunked-IN read —
   * used to annotate a workspace LIST with the viewer's effective role without a per-board
   * round-trip. Empty map when the member tier isn't wired or nothing matches. The repo
   * returns a serializable `Record` (so it round-trips over the mothership RPC); we rebuild
   * the `Map` the controller consumes here.
   */
  async rolesForUserInWorkspaces(
    userId: string,
    workspaceIds: string[],
  ): Promise<Map<string, WorkspaceRole>> {
    const roles = await (this.workspaceMemberRepository?.getRolesForUserInWorkspaces(
      userId,
      workspaceIds,
    ) ?? Promise.resolve({}))
    return new Map(Object.entries(roles))
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

    // Creator auto-enroll (workspace-rbac): seed an `admin` member row for the creator so a
    // non-admin account member keeps admin control of a board they created even if it is later
    // restricted. Harmless in the default `account` mode (an upgrade-only overlay). System grant
    // ⇒ `addedByUserId: null`. Skipped when there's no signed-in creator (dev-open) or the member
    // tier isn't wired.
    if (ownerUserId && this.workspaceMemberRepository) {
      await this.workspaceMemberRepository.upsert({
        workspaceId: workspace.id,
        userId: ownerUserId,
        role: 'admin',
        createdAt: this.clock.now(),
        addedByUserId: null,
      })
    }

    // The built-in pipeline catalog is product configuration, not sample data, so
    // every board gets it — including the empty boards real users start with.
    for (const pipeline of seedPipelines(this.pipelineRegistry)) {
      await this.pipelineRepository.insert(workspace.id, pipeline)
    }
    // The built-in MERGE PRESET library, for the same reason and on the same footing: the run
    // path reads a task's governing policy without ever listing the library, so seeding it on a
    // read would leave a board nobody had opened governed by the built-in fallback (see
    // `riskPolicyRepository` above). One shared row mapping with `RiskPolicyService.reseed`, so
    // a later reseed restores a built-in to what creation wrote rather than to a second copy.
    if (this.riskPolicyRepository) {
      for (const preset of riskPolicySeedRows(this.clock.now())) {
        await this.riskPolicyRepository.upsert(workspace.id, preset)
      }
    }
    // The sample architecture blocks are opt-in (demo boards + the test fixtures);
    // production boards start empty (the SPA creates with `seed: false`).
    if (input.seed ?? true) {
      await this.seedBoard(workspace.id)
    }
    // Seed the deployment's pre-declared environment handlers onto the new board (idempotently),
    // so a service's declared provision type resolves an infra handler with no manual SPA step.
    // Late-bound (the seeder is built after this service in the container) and absent ⇒ a no-op;
    // the seeder swallows per-seed failures, so this never fails workspace creation.
    await this.getEnvironmentHandlerSeeder?.()?.ensureForWorkspace(workspace.id)
    // …and the pre-declared shared stacks, under exactly the same rules (idempotent, late-bound,
    // per-seed fault-tolerant), so a board comes up able to attach to the deployment's infra.
    await this.getSharedStackSeeder?.()?.ensureForWorkspace(workspace.id)
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
    const [localBlocks, allPipelines, localExecutions] = await Promise.all([
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
    // built-in copies and offer a reseed (see WorkspaceSnapshot.pipelineCatalogVersions), plus the
    // companion NAME map, which is the only way the "new built-ins" advisory can name a catalog
    // entry this board holds no row for. ONE read, so neither map can be built from a catalog the
    // other did not see (they do NOT carry the same ids — see each below).
    const catalog = seedPipelines(this.pipelineRegistry)
    // INTERNAL pipelines are withheld from the snapshot for the same reason `PipelineService.list`
    // withholds them: the SPA builds every picker and the builder library off this array, and a
    // pipeline the platform starts on its own behalf is not a choice anyone makes. Filtered here,
    // against the catalog this snapshot already built, rather than at the read above — the answer
    // is a property of the DEFINITION, so the catalog is what has to be asked.
    const pipelines = offeredPipelines(allPipelines, catalog)
    // VERSIONS carries only what a board may be told is available, because the SPA's health
    // advisory derives "new built-ins" as exactly this map's keys MINUS the stored rows it can
    // see — and it can never see an internal one, since `pipelines` above withholds them. Listing
    // an internal entry here therefore reports it as new on every board forever, and the reseed the
    // advisory offers cannot clear it: the row it creates is filtered straight back out.
    const offeredCatalog = offeredPipelines(catalog, catalog)
    const pipelineCatalogVersions = Object.fromEntries(
      offeredCatalog.map((p) => [p.id, p.version ?? 0]),
    )
    // NAMES is a display dictionary rather than an availability list, so it spans the WHOLE catalog
    // — the advisory names entries from `pipelineCatalogVersions` (a subset), and a task PINNED to
    // an internal pipeline needs its name on the card that offers to start it. Narrowing this to
    // the offered set would leave that card naming an id.
    const pipelineCatalogNames = Object.fromEntries(catalog.map((p) => [p.id, p.name]))
    // The complement: built-ins WITHDRAWN from the catalog, so the SPA can offer to remove a stored
    // copy this board was seeded with before the withdrawal. `seedPipelines` already excludes these,
    // so a retired id reaches the SPA through this channel alone — which is what keeps the "new
    // built-ins available" advisory from offering to re-add one (see WorkspaceSnapshot).
    const retired = retiredPipelines(this.pipelineRegistry)
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
      pipelineCatalogNames,
      ...(retired.length ? { retiredPipelines: retired } : {}),
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
    const frameLayout = new Map<string, WorkspaceMount>()
    // Resolve every mounted service in one batched query (not a `get` per mount).
    const services = await this.serviceRepository.listByIds(mounts.map((m) => m.serviceId))
    const frameOf = new Map(services.map((s) => [s.id, s.frameBlockId]))
    const foreignServiceIds: string[] = []
    for (const mount of mounts) {
      const frameBlockId = frameOf.get(mount.serviceId)
      if (!frameBlockId) continue
      frameLayout.set(frameBlockId, mount)
      // Pull in the subtree only for services homed in ANOTHER workspace — a local service's
      // blocks are already in `localBlocks`.
      if (!localIds.has(frameBlockId)) foreignServiceIds.push(mount.serviceId)
    }
    // One batched query for all foreign subtrees (not one per service).
    for (const b of await this.blockRepository.listByServices(foreignServiceIds)) {
      if (!byId.has(b.id)) byId.set(b.id, b)
    }

    // The same projection every single-block mutation response goes through, so the snapshot and
    // a mutation's authoritative block can never disagree about where a frame sits.
    return [...byId.values()].map((b) => applyMountLayout(b, frameLayout.get(b.id)))
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
    // Reclaim the board's binary artifacts (screenshots + reference images) — BOTH the metadata
    // rows AND the heavy blob bytes — BEFORE the row cascade. The retention sweeps only ever see
    // LIVE workspaces (`listVisible`), so a deleted board's artifacts would otherwise leak their
    // object-storage bytes forever; and `binary_artifacts` is deliberately excluded from the
    // `workspaceRepository.delete` cascade (bare SQL can't reach the blob backend, and dropping
    // the metadata row alone strands the bytes). Best-effort: a storage hiccup must not block the
    // board delete, so a purge failure is swallowed here (the row cascade skips the table, so the
    // rows survive rather than orphaning the bytes). But because a deleted board never reappears
    // in `listVisible`, no retention sweep will revisit those rows — reclaim is then out-of-band,
    // so the failure is LOGGED (not silent) rather than promising an auto-retry that can't happen.
    await this.purgeBinaryArtifacts(id)
    // Freeze the board's remaining spend into the durable cost rollup while the rows it is
    // folded from are still here. `spend_days` deliberately survives a board delete, but the
    // sweep that fills it only reaches boards that still exist, so without this the board's
    // spend since the last completed rollup day goes with the `token_usage` rows in the cascade
    // below, permanently, and skewing the numbers most for the boards an operator deleted
    // BECAUSE they were expensive. Runs before the cascade for the same reason the artifact
    // purge does: afterwards there is nothing left to read.
    await this.foldFinalSpend(id)
    // Re-home the SHARED services this board homes: a service another board still mounts must NOT
    // be destroyed just because its home board is deleted (both teams lose the shared subtree).
    // Resolve, per homed service, whether a surviving board mounts it and hand the cascade a
    // re-home plan; services with no other mount fall through to the normal reclaim.
    const rehome = await this.planSharedServiceRehome(id)
    await this.workspaceRepository.delete(id, rehome)
    // Drop every cached access decision for the now-deleted board (workspace-rbac): the roster
    // cascaded away with the row, so a stale grant/denial entry would just be dead weight until
    // its TTL. Invalidate after the delete commits (invalidation is the coherence story, not the
    // TTL). No-op when the cache isn't wired.
    await this.workspaceAccessCache?.invalidateGroup(id)
  }

  /** Purge every binary artifact (rows + blob bytes) of a board being deleted. No-op when the
   * artifact store isn't wired (no content storage configured / tests). Partial per-blob failures
   * are surfaced by the composed store itself; this catch handles a TOTAL failure (store resolve /
   * outage) so it can't wedge the delete. */
  private async purgeBinaryArtifacts(id: string): Promise<void> {
    if (!this.resolveBinaryArtifactStore) return
    try {
      const store = await this.resolveBinaryArtifactStore(id)
      await store?.deleteByWorkspace(id)
    } catch (error) {
      // A blob-backend outage must not wedge the board delete; the rows stay (cascade skips the
      // table). But a deleted board never returns to `listVisible`, so no sweep will retry — log
      // the residual leak (bytes + rows) so it's visible for an out-of-band reclaim, not silent.
      this.logger?.info(
        'workspace-delete binary-artifact purge failed; artifacts retained for out-of-band reclaim',
        { workspaceId: id, err: getErrorMessage(error) },
      )
    }
  }

  /**
   * The last durable fold a board ever gets, run inside its delete. Walks from `now` back towards
   * where the sweep would have resumed (its own watermark, corrected by the trailing lookback) in
   * chunks, because unlike a sweep pass there is no next one: whatever this does not cover is
   * gone with the cascade rather than deferred.
   *
   * BEST-EFFORT, and that posture is a judgement rather than a default. Refusing the delete on a
   * failed fold would keep the board, its ledger and the un-folded days intact for a retry, which
   * is the outcome that loses nothing; it would also render a reporting outage as a board the
   * user cannot delete. The delete wins that trade, so the loss is NAMED instead, because it is
   * unrecoverable the moment the cascade takes the ledger rows.
   *
   * Which is what makes the two DEGRADATIONS below part of that same trade rather than laxity.
   * A chunk that throws does not end the walk, and the walk does not outlast
   * {@link FINAL_SPEND_FOLD_BUDGET_MS}: an all-or-nothing walk hands one slow or sick chunk the
   * power to drop every remaining one, and an unbounded walk hands a stale watermark the power to
   * spend a Worker's whole invocation before the cascade runs at all, which turns "the board's
   * spend was not preserved" into "the board cannot be deleted, identically, on every retry".
   * Both degradations are the same shape: keep going, keep the recent days first
   * ({@link finalSpendFoldPlan} orders for exactly this), and account for what was dropped.
   */
  private async foldFinalSpend(id: string): Promise<void> {
    const rollup = this.spendRollupRepository
    if (!rollup) return
    // Normalised here rather than gated on: an unwired logger is a reason for the fold to run
    // quietly, never a reason to skip preserving the spend.
    const logger = this.logger ?? noopLogger
    const startedAt = this.clock.now()
    const plan = await runBestEffort(
      logger,
      'workspace-delete final spend fold plan',
      async () =>
        finalSpendFoldPlan(
          await rollup.spendRollupWatermark(),
          startedAt,
          this.tokenUsageRetentionMs,
        ),
      { workspaceId: id },
    )
    if (!plan) {
      // No resume point, so no walk at all: the board's whole un-rolled tail goes with the
      // cascade. Its extent is genuinely unknown here (reading it is what failed), and saying so
      // beats naming a span derived from a watermark nothing could read.
      logger.warn(UNFOLDED_SPEND_MSG, {
        workspaceId: id,
        table: 'spend_days',
        reason: 'watermark_unreadable',
      })
      return
    }
    if (plan.skipped) {
      // Days past the ledger's own retention: already unfoldable before this delete, and
      // the only notice they ever get, since nothing downstream can restate a gap.
      logger.warn(
        'workspace-delete could not fold spend the ledger no longer holds; ' +
          'that attribution is permanently absent',
        {
          workspaceId: id,
          table: 'spend_days',
          skippedFrom: plan.skipped.from,
          skippedTo: plan.skipped.to,
        },
      )
    }
    const walk = await this.walkFinalSpendFold(rollup, id, plan.spans, startedAt)
    if (walk.failed.length + walk.unattempted.length > 0) {
      logger.warn(UNFOLDED_SPEND_MSG, {
        workspaceId: id,
        table: 'spend_days',
        // Two fields rather than one, because the two causes need opposite responses: chunks the
        // store REFUSED point at the store, chunks the budget never REACHED point at a sweep left
        // behind long enough for one board's catch-up to outgrow a request. One count over both
        // would present a healthy-but-overdue deployment as a broken one.
        //
        // And spans rather than an extent over them: a chunk that failed in the middle of a walk
        // that otherwise succeeded leaves a HOLE, which a single `[from, to)` pair would render
        // as a clean truncation. Bounded by the plan, which the budget already keeps short.
        failedSpans: walk.failed.map(spanPair),
        unattemptedSpans: walk.unattempted.map(spanPair),
        foldedSpans: plan.spans.length - walk.failed.length - walk.unattempted.length,
        ...walk.cause,
      })
    }
  }

  /**
   * Fold `spans` (newest first) one at a time, returning the ones that did not land, split by
   * why: `failed` was attempted and refused, `unattempted` was never reached.
   *
   * Sequential, not parallel: the spans share a table and each is one rewrite transaction, so
   * overlapping them buys nothing and contends on the same rows.
   *
   * The budget is checked BETWEEN chunks, which bounds how many aggregates the delete runs rather
   * than how long any one of them takes. Preempting a chunk already in flight would need a
   * cancellation signal the repository port does not carry, and that neither a D1 batch nor a
   * Postgres statement would honour mid-query; the per-chunk span cap is what bounds one of them,
   * and is why a single overrun is the residual here rather than the whole plan's worth.
   */
  private async walkFinalSpendFold(
    // Taken as an argument rather than re-read off `this`: the caller has already established the
    // rollup is wired, and an optional chain here would turn a wiring mistake into a silent walk
    // that folds nothing and reports everything as folded.
    rollup: NonNullable<WorkspaceServiceDependencies['spendRollupRepository']>,
    id: string,
    spans: readonly SpendFoldSpan[],
    startedAt: number,
  ): Promise<{ failed: SpendFoldSpan[]; unattempted: SpendFoldSpan[]; cause: LogFields }> {
    const failed: SpendFoldSpan[] = []
    let cause: LogFields = {}
    for (const [index, span] of spans.entries()) {
      if (this.clock.now() - startedAt >= FINAL_SPEND_FOLD_BUDGET_MS) {
        return { failed, unattempted: spans.slice(index), cause }
      }
      try {
        await rollup.rollupWorkspaceSpendDays(id, span.from, span.to)
      } catch (error) {
        // Deliberately not `runBestEffort`: the failure changes what this loop does (carry on to
        // the older chunks and account for this one at the end), which is the case its own doc
        // sends to a real `catch`. A warn per chunk would also report one store outage fourteen
        // times while saying nothing about the walk as a whole.
        failed.push(span)
        // First cause only. Chunk failures in one walk are the same store failing repeatedly far
        // more often than they are distinct faults, and the span list already says how many.
        if (failed.length === 1) cause = describeError(error)
      }
    }
    return { failed, unattempted: [], cause }
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
