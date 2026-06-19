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
  get(workspaceId: string, id: string): Promise<Block | null>
  insert(workspaceId: string, block: Block): Promise<void>
  update(workspaceId: string, id: string, patch: BlockPatch): Promise<void>
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
