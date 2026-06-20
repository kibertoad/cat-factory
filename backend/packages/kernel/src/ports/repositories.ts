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
export type WorkspaceVisibility = { accountIds: string[]; ownerUserId: number } | null

export interface WorkspaceRepository {
  /**
   * List boards visible to a user (see {@link WorkspaceVisibility}). A `null`
   * scope means ownership is not being enforced (auth disabled) and ALL boards
   * are returned.
   */
  listVisible(scope: WorkspaceVisibility): Promise<Workspace[]>
  get(id: string): Promise<Workspace | null>
  /**
   * The owning user id for a board: a number when owned, `null` for a board with
   * no owner, and `undefined` when the board does not exist.
   */
  ownerOf(id: string): Promise<number | null | undefined>
  /**
   * The owning account id for a board: a string when account-scoped, `null` for a
   * legacy/unscoped board, and `undefined` when the board does not exist. Used by
   * the API's per-workspace authorization check.
   */
  accountOf(id: string): Promise<string | null | undefined>
  create(workspace: Workspace, ownerUserId: number | null, accountId: string | null): Promise<void>
  rename(id: string, name: string): Promise<void>
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
  upsert(workspaceId: string, execution: ExecutionInstance): Promise<void>
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
