import type {
  AgentFailure,
  Block,
  ExecutionInstance,
  Pipeline,
  Workspace,
} from '../domain/types.js'

// ---------------------------------------------------------------------------
// Repository ports: persistence interfaces the domain layer depends on. The
// worker's infrastructure layer implements them against D1; tests could supply
// in-memory fakes. The domain never imports a concrete adapter, which is what
// keeps this package framework-agnostic.
// ---------------------------------------------------------------------------

/**
 * The set of boards a signed-in user may see: those belonging to an account they
 * are a member of, plus any legacy boards they personally own (account_id NULL,
 * owner_user_id = them). `null` means "no scoping" — the auth-disabled / local-dev
 * path, where every board is returned.
 */
export type WorkspaceVisibility = { accountIds: string[]; ownerUserId: string } | null

export interface WorkspaceRepository {
  /**
   * List boards visible to a user (see {@link WorkspaceVisibility}). A `null`
   * scope means ownership is not being enforced (auth disabled) and ALL boards
   * are returned.
   */
  listVisible(scope: WorkspaceVisibility): Promise<Workspace[]>
  get(id: string): Promise<Workspace | null>
  /**
   * The owning user id for a board: a string when owned, `null` for a board with
   * no owner, and `undefined` when the board does not exist.
   */
  ownerOf(id: string): Promise<string | null | undefined>
  /**
   * The owning account id for a board: a string when account-scoped, `null` for a
   * legacy/unscoped board, and `undefined` when the board does not exist. Used by
   * the API's per-workspace authorization check.
   */
  accountOf(id: string): Promise<string | null | undefined>
  create(workspace: Workspace, ownerUserId: string | null, accountId: string | null): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Update a board's description (null clears it). */
  setDescription(id: string, description: string | null): Promise<void>
  delete(id: string): Promise<void>
}

/**
 * Fields of a block that may be patched. Excludes `id`; the `parentId`/`position`
 * structural move is just another patch, kept honest by the adapter.
 */
export type BlockPatch = Partial<Omit<Block, 'id'>>

export interface BlockRepository {
  listByWorkspace(workspaceId: string): Promise<Block[]>
  /**
   * Every block belonging to a service (its frame + modules + tasks), regardless of
   * which workspace created them. Backs the board composition that renders a service
   * mounted from another workspace in the same org. Returns the blocks whose
   * `service_id` column matches (set at insert time when the service repos are wired).
   */
  listByService(serviceId: string): Promise<Block[]>
  /**
   * Every block belonging to ANY of the given services, in a single (chunked) query — the
   * batched form of {@link BlockRepository.listByService} used to compose a board from all the
   * services it mounts without one round-trip per service. Empty input → empty result.
   */
  listByServices(serviceIds: string[]): Promise<Block[]>
  get(workspaceId: string, id: string): Promise<Block | null>
  /**
   * Resolve a block by its (globally unique) id, regardless of which workspace homes it,
   * returning the block plus its home `workspaceId` and its `serviceId` (or null). Backs
   * the shared-board mutation path: a block belonging to a service mounted from another
   * workspace is acted on at its home workspace (after the caller authorizes that the
   * requester mounts the service). Returns null when no block has that id.
   */
  findById(
    blockId: string,
  ): Promise<{ workspaceId: string; serviceId: string | null; block: Block } | null>
  /**
   * The batched form of {@link BlockRepository.findById}: resolve every id that exists, in a
   * single (chunked) query — used to augment a board's block list with cross-workspace
   * dependency blocks without one round-trip per id. Ids with no block are simply absent
   * from the result. Empty input → empty result.
   */
  findByIds(
    blockIds: string[],
  ): Promise<Array<{ workspaceId: string; serviceId: string | null; block: Block }>>
  /**
   * Insert a block. `serviceId` stamps the account-owned service the block belongs to
   * (so it can be rendered on every workspace that mounts the service); omit/undefined
   * for legacy, workspace-local blocks.
   */
  insert(workspaceId: string, block: Block, serviceId?: string | null): Promise<void>
  update(workspaceId: string, id: string, patch: BlockPatch): Promise<void>
  /**
   * Re-stamp the `service_id` of one or more blocks. Used when a block is reparented into a
   * different service's frame (`service_id` is not part of {@link BlockPatch}, since it is the
   * physical scope key, not a domain field): the moved subtree must follow its new owning
   * service so it renders on — and fans out to — the right boards.
   */
  setService(workspaceId: string, ids: string[], serviceId: string | null): Promise<void>
  deleteMany(workspaceId: string, ids: string[]): Promise<void>
}

export interface PipelineRepository {
  listByWorkspace(workspaceId: string): Promise<Pipeline[]>
  get(workspaceId: string, id: string): Promise<Pipeline | null>
  insert(workspaceId: string, pipeline: Pipeline): Promise<void>
  /** Overwrite an existing pipeline in place (preserving its catalog order). */
  update(workspaceId: string, pipeline: Pipeline): Promise<void>
  delete(workspaceId: string, id: string): Promise<void>
}

/** A lightweight reference to a run, used by the cron sweeper. */
export interface RunRef {
  workspaceId: string
  id: string
}

export interface ExecutionRepository {
  listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]>
  /**
   * Every execution belonging to a service, regardless of which workspace it ran under.
   * Backs the board snapshot for a service mounted from another workspace in the same org,
   * so its run progress/status renders identically on every board that mounts it (not just
   * on its home workspace). Matches the `service_id` column stamped at insert time.
   */
  listByService(serviceId: string): Promise<ExecutionInstance[]>
  /**
   * Every execution belonging to ANY of the given services, in a single (chunked) query — the
   * batched form of {@link ExecutionRepository.listByService} used to compose a board's runs
   * from all the services it mounts without one round-trip per mount. Empty input → empty.
   */
  listByServices(serviceIds: string[]): Promise<ExecutionInstance[]>
  get(workspaceId: string, id: string): Promise<ExecutionInstance | null>
  getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null>
  /**
   * Persist the run (force-write). Bumps the row's monotonic `rev` on every write so a
   * concurrent {@link ExecutionRepository.compareAndSwap} can detect that the row moved.
   * Used by the durable driver and lifecycle transitions, which own the run's progress.
   */
  upsert(workspaceId: string, execution: ExecutionInstance): Promise<void>
  /**
   * Atomically replace a block's prior run with a brand-new live one, but ONLY if no OTHER
   * live execution run (`running`/`blocked`/`paused`) exists for the block. In ONE
   * transaction it (1) deletes the block's terminal (`done`/`failed`) rows plus, when
   * `replaceId` is given, that specific prior row (the run the caller is knowingly
   * superseding — e.g. a `restart` that already tore its source down), then (2) inserts the
   * new run guarded by the partial unique index on `(workspace_id, block_id)` over live rows.
   *
   * Doing the cleanup and the insert as a single unit is what makes the one-live-run-per-block
   * invariant hold under concurrency: a losing insert never deletes the winner (the delete only
   * ever removes terminal rows and the caller's own `replaceId` — never another writer's fresh
   * live row), and the index rejects a second live insert. So two genuinely-concurrent starts
   * (double-click, a recurring fire racing a manual start, a notification retry racing a human
   * retry) can never create two live runs — two drivers, two containers — for one block. This
   * is why callers MUST NOT `deleteByBlock` first: an unconditional pre-delete would wipe a
   * concurrent winner and re-open the exact race this method closes.
   *
   * Returns `true` when the row was inserted (and sets the in-memory `execution.rev` to its
   * fresh value); returns `false` with NO net write (the transaction still commits the
   * terminal/`replaceId` cleanup, but no new run) when another live run already exists, so the
   * caller rejects the duplicate start rather than materialising a second run.
   */
  insertLive(
    workspaceId: string,
    execution: ExecutionInstance,
    opts?: { replaceId?: string },
  ): Promise<boolean>
  /**
   * Optimistic-concurrency write: persist `execution` only if the stored row's `rev`
   * still equals the `rev` last read onto this instance. Returns `true` (and bumps the
   * in-memory `execution.rev`) when the write lands; returns `false` with NO write when
   * another writer advanced the row meanwhile, so the caller can re-read and re-apply
   * its mutation on fresh state instead of clobbering it. Only updates an existing row
   * (never inserts) — the run must already exist. The fix for human-action lost-updates
   * (concurrent resolve-decision / approve / request-changes); see `mutateInstance`.
   */
  compareAndSwap(workspaceId: string, execution: ExecutionInstance): Promise<boolean>
  deleteByBlock(workspaceId: string, blockId: string): Promise<void>
  /**
   * Runs still marked `running` whose lease (`updated_at`) is older than the
   * given epoch-ms cutoff — i.e. candidates the durable driver may have dropped.
   * Spans all workspaces so a single cron pass can repair the whole system.
   */
  listStale(olderThanEpochMs: number): Promise<RunRef[]>
  /**
   * Record a terminal agent failure: flip the run to `failed` and store the
   * structured {@link AgentFailure} (its `message` mirrors the legacy one-line
   * `error`). Surfaces the same failure banner + retry as a failed bootstrap.
   */
  markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void>
}
