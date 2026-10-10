import type {
  AgentFailure,
  Block,
  BlockStatus,
  ExecutionInstance,
  ExecutionStatus,
  Pipeline,
  RunDefaultScope,
  Workspace,
  WorkspaceAccessMode,
} from '../domain/types.js'
import type { WorkspaceAccessRow } from '../domain/workspace-access.js'

// ---------------------------------------------------------------------------
// Repository ports: persistence interfaces the domain layer depends on. The
// worker's infrastructure layer implements them against D1; tests could supply
// in-memory fakes. The domain never imports a concrete adapter, which is what
// keeps this package framework-agnostic.
// ---------------------------------------------------------------------------

/**
 * The set of boards a signed-in user may see, resolved SQL-side (never a JS post-filter —
 * the banned N+1 class). A board is visible when ANY of these holds:
 *  - it is an UNRESTRICTED board in an account the user belongs to
 *    (`account_id IN (accountIds) AND access_mode = 'account'`);
 *  - it is ANY board (incl. restricted) in an account the user is an ADMIN of
 *    (`account_id IN (adminAccountIds)` — the escape hatch, no lock-out is possible);
 *  - the user holds an explicit `workspace_members` row on it, ANDed with the caller's
 *    account ids so an orphaned row in a foreign account can't resurface a denied board;
 *  - it is a legacy board the user personally owns (`account_id IS NULL AND
 *    owner_user_id = them`).
 *
 * `null` means "no scoping" — the auth-disabled / local-dev path, where every board is
 * returned. `ownerUserId` matches the legacy-board owner column; `userId` is the same
 * caller identity used for the admin/membership predicates (kept distinct so the semantic
 * of each clause reads at the call site).
 */
export type WorkspaceVisibility = {
  accountIds: string[]
  adminAccountIds: string[]
  ownerUserId: string
  userId: string
} | null

export interface WorkspaceRepository {
  /**
   * List boards visible to a user (see {@link WorkspaceVisibility}). A `null`
   * scope means ownership is not being enforced (auth disabled) and ALL boards
   * are returned.
   */
  listVisible(scope: WorkspaceVisibility): Promise<Workspace[]>
  /**
   * Every board owned by an account (`account_id = accountId`), in one query. Backs the
   * account-tier GitHub-installation resolution for the content libraries (fragments /
   * skills): an installation row's own `account_id` can be null (a per-workspace PAT
   * connect) or a foreign id (local mode's synthetic rows carry the PAT's GitHub account),
   * so the account tier resolves through its workspaces' installations instead — which
   * needs "the account's boards" as a batched read, never a per-installation point lookup.
   */
  listByAccount(accountId: string): Promise<Workspace[]>
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
  /**
   * The batched form of {@link accountOf}: the owning account of each named board, in one
   * (chunked) query, keyed by workspace id. A board that does not exist has NO KEY rather than a
   * null one, which is the same distinction `accountOf` draws with its two nullish answers: null
   * is the accountless (legacy) board, so read the absence with `Object.hasOwn`.
   *
   * Exists because several callers bind a LIST of boards to the token scope at once (the
   * persistence RPC's `workspaceList` rule, its block-list resolver, the installation owner
   * lookups behind a PAT binding), each a point read per id before. A plain object rather than a
   * `Map` because this crosses the mothership-mode persistence RPC, whose envelope is JSON: the
   * same shape `WorkspaceMemberRepository.getRolesForUserInWorkspaces` answers with.
   */
  accountIdsOf(ids: string[]): Promise<Record<string, string | null>>
  /**
   * The narrow access row workspace-RBAC resolution reads in one hot-path query
   * (replacing the gate's separate `accountOf`): the owning account, the legacy owner,
   * and the board's access mode. `undefined` when the board does not exist.
   */
  accessRowOf(id: string): Promise<WorkspaceAccessRow | undefined>
  /** Flip a board's workspace-RBAC access mode (`account` | `restricted`). */
  setAccessMode(id: string, mode: WorkspaceAccessMode): Promise<void>
  /**
   * Adopt a legacy (`account_id IS NULL`) board into an account — the auto-heal the member
   * service runs so a roster / restriction can take effect on a previously unscoped board (an
   * unscoped board is invisible to resolution's account tier). Sets `account_id` only; the owner
   * column is left untouched.
   */
  linkAccount(id: string, accountId: string): Promise<void>
  create(workspace: Workspace, ownerUserId: string | null, accountId: string | null): Promise<void>
  rename(id: string, name: string): Promise<void>
  /** Update a board's description (null clears it). */
  setDescription(id: string, description: string | null): Promise<void>
  /**
   * Delete a board and cascade its owned rows. `rehome` re-homes SHARED services this board homes
   * that another board still mounts: each entry moves a service's blocks (and their run history)
   * to a surviving mounting workspace BEFORE the cascade, so a shared service outlives its home
   * board's deletion instead of being destroyed for every team that mounts it. A service with no
   * surviving mount is omitted (the cascade reclaims it). Empty/absent ⇒ the plain cascade.
   */
  delete(id: string, rehome?: ServiceRehome[]): Promise<void>
}

/** Move a homed service's content to a surviving mounting board on its home-board deletion. */
export interface ServiceRehome {
  serviceId: string
  toWorkspaceId: string
}

/**
 * Fields of a block that may be patched. Excludes `id`; the `parentId`/`position`
 * structural move is just another patch, kept honest by the adapter.
 *
 * `completedAt` is excluded too, and for a different reason: it is DERIVED by the
 * repository from the status this patch sets (see `blockCompletionStamp`), so the
 * several places that mark a task `done` cannot each remember to stamp it — and one
 * of them eventually would not. Excluding it here makes handing one in a typecheck
 * failure rather than a write the repository silently overrules.
 */
export type BlockPatch = Partial<Omit<Block, 'id' | 'completedAt'>>

export interface BlockRepository {
  listByWorkspace(workspaceId: string): Promise<Block[]>
  /**
   * Every block belonging to ANY of the given services (its frame + modules + tasks), in a
   * single (chunked) query — the board composition that renders every service a workspace
   * mounts, without one round-trip per service. Matches the `service_id` column stamped at
   * insert time. Empty input → empty result.
   */
  listByServices(serviceIds: string[]): Promise<Block[]>
  get(workspaceId: string, id: string): Promise<Block | null>
  /**
   * The block currently running `executionId`, read off the `execution_id` REVERSE LINK a run
   * start/retry stamps on it, or null when no block in this workspace carries that run.
   *
   * It exists for the one case where the run itself cannot answer: a run row that fails its own
   * decode names no block, and yet the block naming the RUN is right there. Without this the
   * disposal of a poison run settles the row and leaves the card wedged `in_progress` forever, with
   * the run dropped from the board snapshot so there is no failure card and no Retry either.
   *
   * At most one block matches: the id is minted per run and only the block the run was started on
   * is ever stamped with it. Cheap without an index of its own, being anchored on the
   * `(workspace_id, …)` primary-key prefix over one board's blocks.
   */
  getByExecution(workspaceId: string, executionId: string): Promise<Block | null>
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
  /**
   * Translate every DIRECT child of `parentId` by `(dx, dy)`, in ONE statement.
   *
   * A child's position is relative to its container's content origin, so a resize that moves
   * that origin — dragging a frame's or module's north/west border — has to move the children
   * the other way or the whole content slides with the border. The alternative shapes are both
   * banned: a per-child `update` in a loop is the N+1 this codebase forbids, and inferring the
   * shift inside `update` would wrongly fire on a plain container MOVE (where children are meant
   * to travel with their parent). Hence one arithmetic UPDATE expressing exactly that intent.
   *
   * Grandchildren need no pass of their own: a task inside a module is positioned relative to
   * the MODULE, which this statement moves as a unit.
   */
  shiftChildPositions(workspaceId: string, parentId: string, dx: number, dy: number): Promise<void>
  deleteMany(workspaceId: string, ids: string[]): Promise<void>
  /**
   * Count the workspace's HEADLESS internal anchor blocks (`internal = 1`) still in flight
   * (`status = 'in_progress'`) — the concurrency backstop for the public API, which caps how
   * many external "initiative" runs a workspace can have active at once. A SQL `COUNT`, never a
   * load-and-count in JS (an unbounded external caller could otherwise start runs without limit).
   */
  countActiveInternal(workspaceId: string): Promise<number>
  /**
   * One BOUNDED page of a service frame's `task`-level blocks — the WHOLE task subtree (tasks
   * directly under the frame AND under its modules), excluding the headless `internal` anchors.
   * Backs the public API's paginated service-task list, which previously read the ENTIRE board
   * (`listByWorkspace`) and filtered the subtree in JS — so a large board paid a full table read
   * per external page request.
   *
   * The subtree resolves in ONE query: a `task` may only be parented by a `frame` or a `module`
   * (enforced by `canReparent` on reparent AND by `BoardService.addTask` on create), so
   * "parented by the frame, or by a module of the frame" is exhaustive — there is no deeper
   * level to recurse through, which is what makes the general `descendantIds` walk (and its
   * whole-board read) unnecessary here. The module leg is a SUBQUERY rather than an id list
   * resolved by a prior read: D1 hard-rejects a statement with more than 100 bound parameters
   * (see `chunkForIn`), so an `IN (...)` over a service's modules would 500 on a service that
   * accumulated ~96 of them — and blueprint reconciliation only ever ADDS modules.
   *
   * Ordered by `id` ASC — blocks carry no creation timestamp, so id order is arbitrary but
   * STABLE, which is what a keyset cursor actually needs. `afterId` is exclusive. `limit` is the
   * row cap (the caller reads one extra row to detect a further page).
   */
  listServiceTasks(
    workspaceId: string,
    frameId: string,
    opts: { limit: number; afterId?: string; status?: BlockStatus },
  ): Promise<Block[]>
}

export interface PipelineRepository {
  listByWorkspace(workspaceId: string): Promise<Pipeline[]>
  get(workspaceId: string, id: string): Promise<Pipeline | null>
  insert(workspaceId: string, pipeline: Pipeline): Promise<void>
  /**
   * Insert a pipeline unless the workspace already holds that id, in which case do nothing:
   * FIRST WRITE WINS, targeted on the composite `(workspace_id, id)` key.
   *
   * The shape adoption needs. Materialising a catalog built-in a workspace was never seeded with
   * (`PipelineService.reseed`'s absent branch, and the run path's adopt-on-start) races with
   * itself: two tasks of the same reusable operation, started at once on a board that never
   * adopted its pipeline, both resolve "no row" and both insert. Both write the SAME catalog
   * definition, so losing the race is not a conflict to report, it is the other writer having
   * already done the work. Deliberately conflict-TARGETED rather than a blanket ignore, so a
   * genuine constraint violation still surfaces on both runtimes (the `INSERT OR IGNORE` trap).
   */
  insertIfAbsent(workspaceId: string, pipeline: Pipeline): Promise<void>
  /** Overwrite an existing pipeline in place (preserving its catalog order). */
  update(workspaceId: string, pipeline: Pipeline): Promise<void>
  /**
   * Claim (`claimed`) or release this pipeline as the workspace's default for `scope`, demoting
   * whichever row held that scope first.
   *
   * Its OWN method rather than two fields on {@link update}, because the two writes are different
   * kinds of thing. `update` overwrites one row's structure and is refused on a built-in; the
   * default flags are selection metadata, are the only pipeline write a built-in accepts, and
   * touch a SECOND row (the incumbent). Folding them into `update` would mean every ordinary edit
   * carried the demotion of a scope it said nothing about.
   *
   * The demote and the promote land as one transaction (a `batch` on D1), for the reason
   * `RiskPolicyRepository.upsert` does: run loose, a demote that commits before a failed promote
   * leaves the scope with NO holder, and "the operator un-set their default" is a state no caller
   * asked for. Releasing a flag nothing holds, or claiming one this row already holds, is a no-op.
   */
  setDefault(
    workspaceId: string,
    id: string,
    scope: RunDefaultScope,
    claimed: boolean,
  ): Promise<void>
  delete(workspaceId: string, id: string): Promise<void>
}

/** A lightweight reference to a run, used by the cron sweeper. */
export interface RunRef {
  workspaceId: string
  id: string
}

/**
 * A lightweight projection of a LIVE execution run — its id, block, and status — with the
 * heavy serialized `detail` (pipeline + per-step state) column deliberately NOT decoded.
 * Returned by {@link ExecutionRepository.listLive} for hot paths that need only the live
 * rows' block/status/id and would otherwise pay to load + JSON-decode every historical run.
 */
export interface LiveRunSummary {
  id: string
  blockId: string
  status: ExecutionStatus
}

/**
 * A workspace's block list captured by one caller and handed to the next so the second
 * doesn't re-list the whole board. Carries the `workspaceId` it was loaded for so the
 * consumer can only reuse it when its own resolved workspace matches (e.g. a locally-owned
 * block whose home == the acting workspace) and re-lists otherwise (a mounted shared
 * service homed elsewhere). Used across the block-delete path (teardown → removeBlock).
 */
export interface PreloadedBlocks {
  workspaceId: string
  blocks: Block[]
}

/**
 * The execution statuses that count as LIVE: a run in one of these has not settled, holds its
 * block, and occupies a workspace concurrency slot. Shared by {@link ExecutionRepository.listLive}
 * and {@link ExecutionRepository.countActiveByWorkspace} in BOTH runtime repos, so the projection
 * and the capacity COUNT cannot drift apart into a cap checked against a set the board disagrees
 * with (`docs/initiatives/run-admission-control.md`).
 *
 * It is the complement of the terminal statuses over {@link ExecutionStatus}, so a new status has
 * to be classified here rather than silently falling out of both reads.
 *
 * NOT to be reused for the `insertLive` cleanup/ON CONFLICT predicates. Those mirror the frozen
 * partial unique index `uniq_live_execution_per_block`, whose predicate lives in shipped
 * migrations and can only change by migrating both stores — pointing them at a constant a later
 * slice may edit would silently retarget an ON CONFLICT at a predicate no index matches. Same
 * literal today, different invariant.
 */
export const LIVE_EXECUTION_STATUSES = [
  'running',
  'blocked',
  'paused',
] as const satisfies readonly ExecutionStatus[]

export interface ExecutionRepository {
  listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]>
  /**
   * The workspace's LIVE execution runs (`running`/`blocked`/`paused`) as a lean
   * {@link LiveRunSummary} projection — `{ id, blockId, status }` per row, NEVER the heavy
   * `detail` column. Backs the per-service task-concurrency dispatch guard (needs the live
   * blocks) and `resumePaused` (needs the paused runs' ids), both of which previously loaded
   * and JSON-decoded EVERY historical run in the workspace via {@link listByWorkspace} only to
   * discard all but the handful of live rows — so this scales with concurrency, not run history.
   * Served by the `(workspace_id, kind, status)` index. Empty when no run is live. The predicate
   * is {@link LIVE_EXECUTION_STATUSES}, shared with {@link countActiveByWorkspace}.
   */
  listLive(workspaceId: string): Promise<LiveRunSummary[]>
  /**
   * How many of the workspace's execution runs currently OCCUPY A CONCURRENCY SLOT, as one
   * SQL `COUNT` over the same `(workspace_id, kind, status)` index {@link listLive} rides.
   * Backs run admission control: the cap check in front of the durable driver reads a number,
   * never a row set, so it costs the same whether the workspace has three live runs or three
   * hundred (`docs/initiatives/run-admission-control.md`).
   *
   * "Active" is deliberately the SAME predicate as {@link listLive} — the shared
   * {@link LIVE_EXECUTION_STATUSES}, so the two cannot drift by editing one query. `blocked`
   * (parked on a human decision) and `paused` (spend-paused) are in it: a parked run has no
   * container in flight, but it holds its block and resumes WITHOUT passing admission again, so
   * excluding it would let a workspace exceed its cap simply by parking — every parked run that
   * resumes lands on top of whatever was admitted in its place.
   *
   * The two stay one set only while "not settled" and "occupies a slot" mean the same thing. The
   * `queued` state slice 2 introduces is the first that splits them (queued runs are pre-admission
   * — they must never be counted here, or nothing is ever promoted), and it is what turns this
   * shared constant into two; see the initiative's gotchas before adding a status.
   *
   * Scoped to `kind = 'execution'`, so a live bootstrap job sharing the `agent_runs` table is
   * never counted against a run cap it has nothing to do with.
   */
  countActiveByWorkspace(workspaceId: string): Promise<number>
  /**
   * Every execution belonging to ANY of the given services, in a single (chunked) query, so a
   * shared service's run progress renders identically on every board that mounts it. Matches
   * the `service_id` column stamped at insert time. Empty input → empty.
   */
  listByServices(serviceIds: string[]): Promise<ExecutionInstance[]>
  /**
   * One BOUNDED page of the workspace's HEADLESS initiative runs — executions whose anchor block
   * is `internal` — newest first (`created_at DESC, id DESC`). This is the list form of the
   * `loadPublicJob` double-scope: the `internal` predicate is applied in SQL by joining the
   * anchor block, so the public list can NEVER surface an ordinary board run that merely shares
   * the workspace. Filtering in JS after an unbounded `listByWorkspace` would be both an
   * unbounded read and a scoping rule enforced in the wrong layer.
   *
   * `cursor` is an EXCLUSIVE keyset on the same `(createdAt, id)` composite the ordering uses —
   * not a bare `createdAt`, because a burst of concurrent starts shares a millisecond and a
   * timestamp-only cursor would silently drop the tied rows from the next page. `statuses`
   * filters on the INTERNAL execution status (the caller expands the coarse public status it
   * exposes); `since` is an inclusive lower bound on `created_at`. `limit` caps the rows (the
   * caller reads one extra to detect a further page).
   */
  listInternal(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      statuses?: ExecutionStatus[]
      since?: number
    },
  ): Promise<ExecutionInstance[]>
  /**
   * One BOUNDED page of the workspace's runs, newest first (`created_at DESC, id DESC`) —
   * the run index the remote debugging surface leads with.
   *
   * The sibling of {@link ExecutionRepository.listInternal}, and deliberately WITHOUT its
   * anchor-block join: the public JOB surface may only ever surface runs it created, whereas
   * a debugger that cannot see the run that failed is useless — a service frame's blueprint
   * run and a recurring bug-intake fire are exactly the ones someone asks about. The scope
   * that remains is the workspace, which is the whole reach of the key doing the asking.
   *
   * Same keyset contract as `listInternal` (composite `(createdAt, id)`, exclusive), and the
   * same reason for it. NOT {@link ExecutionRepository.listByWorkspace} with a slice: that
   * one reads and JSON-decodes every historical run in the workspace before anything is
   * discarded, which is precisely what a paginated surface must not do.
   */
  listRecent(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      statuses?: ExecutionStatus[]
      since?: number
    },
  ): Promise<ExecutionInstance[]>
  get(workspaceId: string, id: string): Promise<ExecutionInstance | null>
  /**
   * Whether the workspace has this run — one indexed probe that decodes NOTHING. The 404
   * guard the per-run debug lists apply on EVERY page: answering it with `get` would
   * JSON-decode the heaviest row in the request only to discard it.
   */
  exists(workspaceId: string, id: string): Promise<boolean>
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
