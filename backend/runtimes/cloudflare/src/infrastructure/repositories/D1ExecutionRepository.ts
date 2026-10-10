import {
  type AgentFailure,
  type Clock,
  type ExecutionRepository,
  LIVE_EXECUTION_STATUSES,
  type LiveRunSummary,
  type RunRef,
} from '@cat-factory/kernel'
import type { ExecutionInstance, ExecutionStatus } from '@cat-factory/contracts'
import { tryDecodeRows } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'
import { adoptCreatedAt, type ExecutionRow, executionToDetail, rowToExecution } from './mappers'

const runContext = (row: ExecutionRow) => ({ table: 'agent_runs', id: row.id })

// The live statuses as a SQL list literal, derived from the shared constant so the live-run
// projection and the admission-control capacity COUNT read the same set here and on Node.
// `insertLive` deliberately keeps its literals: those mirror the frozen index predicate
// (see LIVE_EXECUTION_STATUSES).
const LIVE_STATUS_LIST_SQL = LIVE_EXECUTION_STATUSES.map((s) => `'${s}'`).join(', ')

/**
 * Execution runs, stored as `kind='execution'` rows of the unified `agent_runs`
 * table (migration 0019). Every statement is scoped by `kind='execution'` so the
 * bootstrap flow's rows (owned by {@link D1BootstrapJobRepository}) never collide
 * — in particular `deleteByBlock` must NOT delete the bootstrap run that created a
 * service frame when an execution on that block is replaced/cancelled.
 */
export class D1ExecutionRepository implements ExecutionRepository {
  private readonly db: D1Database
  private readonly clock: Clock

  constructor({ db, clock }: { db: D1Database; clock: Clock }) {
    this.db = db
    this.clock = clock
  }

  async listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND kind = 'execution' ORDER BY created_at`,
      )
      .bind(workspaceId)
      .all<ExecutionRow>()
    // Snapshot-facing list read: drop a corrupt run rather than failing the whole board load.
    return tryDecodeRows(results, rowToExecution, runContext)
  }

  async listLive(workspaceId: string): Promise<LiveRunSummary[]> {
    // Lean live-run projection: block_id + status + id only, NEVER the heavy `detail` column.
    // Served by idx_agent_runs_ws_kind_status (workspace_id, kind, status). Unordered: the two
    // consumers (dispatch guard's block-id Set, resumePaused's id iteration) are order-agnostic.
    const { results } = await this.db
      .prepare(
        `SELECT id, block_id, status FROM agent_runs
         WHERE workspace_id = ? AND kind = 'execution'
           AND status IN (${LIVE_STATUS_LIST_SQL})`,
      )
      .bind(workspaceId)
      .all<{ id: string; block_id: string | null; status: LiveRunSummary['status'] }>()
    // `block_id` is nullable on the table; coalesce to '' so the projection matches the Drizzle
    // repo's `string` shape exactly (live execution runs always carry one in practice).
    return results.map((r) => ({ id: r.id, blockId: r.block_id ?? '', status: r.status }))
  }

  async countActiveByWorkspace(workspaceId: string): Promise<number> {
    // Admission-control capacity read: the COUNT is pushed into SQL (never rows reduced in JS),
    // over the same live predicate and index as `listLive` above. Mirrors the Drizzle repo.
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_runs
         WHERE workspace_id = ? AND kind = 'execution'
           AND status IN (${LIVE_STATUS_LIST_SQL})`,
      )
      .bind(workspaceId)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async listByServices(serviceIds: string[]): Promise<ExecutionInstance[]> {
    if (serviceIds.length === 0) return []
    const out: ExecutionInstance[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(serviceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM agent_runs WHERE service_id IN (${placeholders}) AND kind = 'execution' ORDER BY created_at`,
        )
        .bind(...chunk)
        .all<ExecutionRow>()
      out.push(...tryDecodeRows(results, rowToExecution, runContext))
    }
    return out
  }

  async listInternal(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      statuses?: ExecutionStatus[]
      since?: number
    },
  ): Promise<ExecutionInstance[]> {
    // The `internal` scope is enforced by JOINing the anchor block, so an ordinary board run can
    // never leak into the public job list. Driven by idx_agent_runs_workspace (workspace_id,
    // created_at) walked in reverse, probing blocks by its (workspace_id, id) primary key.
    const where = [`r.workspace_id = ?`, `r.kind = 'execution'`, `b.internal = 1`]
    const binds: (string | number)[] = [workspaceId]
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(`r.status IN (${opts.statuses.map(() => '?').join(', ')})`)
      binds.push(...opts.statuses)
    }
    if (opts.since != null) {
      where.push(`r.created_at >= ?`)
      binds.push(opts.since)
    }
    if (opts.cursor) {
      // Composite keyset matching the ORDER BY, so rows sharing a `created_at` are not skipped.
      where.push(`(r.created_at < ? OR (r.created_at = ? AND r.id < ?))`)
      binds.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id)
    }
    const { results } = await this.db
      .prepare(
        `SELECT r.* FROM agent_runs r
         JOIN blocks b ON b.workspace_id = r.workspace_id AND b.id = r.block_id
         WHERE ${where.join(' AND ')}
         ORDER BY r.created_at DESC, r.id DESC
         LIMIT ?`,
      )
      .bind(...binds, opts.limit)
      .all<ExecutionRow>()
    // List read: drop a corrupt run rather than failing the whole page.
    return tryDecodeRows(results, rowToExecution, runContext)
  }

  async listRecent(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      statuses?: ExecutionStatus[]
      since?: number
    },
  ): Promise<ExecutionInstance[]> {
    // Same predicates and ordering as `listInternal`, minus its anchor-block join: the debug
    // run index deliberately spans every run in the workspace (see the port). Driven by
    // idx_agent_runs_workspace (workspace_id, created_at) walked in reverse.
    const where = [`workspace_id = ?`, `kind = 'execution'`]
    const binds: (string | number)[] = [workspaceId]
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`)
      binds.push(...opts.statuses)
    }
    if (opts.since != null) {
      where.push(`created_at >= ?`)
      binds.push(opts.since)
    }
    if (opts.cursor) {
      where.push(`(created_at < ? OR (created_at = ? AND id < ?))`)
      binds.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id)
    }
    const { results } = await this.db
      .prepare(
        `SELECT * FROM agent_runs
         WHERE ${where.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds, opts.limit)
      .all<ExecutionRow>()
    // List read: drop a corrupt run rather than failing the whole page. Note the interaction
    // with the caller's peek-one-extra pagination: a dropped row shrinks the page below
    // `limit + 1`, so a page containing a corrupt run reads as the LAST page and later rows
    // become unreachable until the row is repaired — accepted, matching every other list read.
    return tryDecodeRows(results, rowToExecution, runContext)
  }

  async exists(workspaceId: string, id: string): Promise<boolean> {
    // One indexed probe, no row decode (see the port). Mirrors the Drizzle repo.
    const row = await this.db
      .prepare(
        `SELECT 1 AS one FROM agent_runs WHERE workspace_id = ? AND id = ? AND kind = 'execution'`,
      )
      .bind(workspaceId, id)
      .first<{ one: number }>()
    return row != null
  }

  async get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare(`SELECT * FROM agent_runs WHERE workspace_id = ? AND id = ? AND kind = 'execution'`)
      .bind(workspaceId, id)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM agent_runs WHERE workspace_id = ? AND block_id = ? AND kind = 'execution'`,
      )
      .bind(workspaceId, blockId)
      .first<ExecutionRow>()
    return row ? rowToExecution(row) : null
  }

  async upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    // The pipeline shape lives in `detail`; lifecycle is top-level. `updated_at`
    // is refreshed on every write so it doubles as the sweeper's lease.
    // `error`/`failure`/`workflow_instance_id` are deliberately left out of the
    // conflict update so they survive normal step writes (see markFailed).
    const now = this.clock.now()
    const createdAt = adoptCreatedAt(execution, now)
    const detail = executionToDetail(execution)
    // Stamp `service_id` from the run's block so the run is discoverable by service (in-org
    // sharing): a shared service's runs surface on every board that mounts it via
    // `listByService`. Derived here (not carried on ExecutionInstance) and refreshed on every
    // write so it follows a reparent that re-homes the block to another service.
    // `rev` is bumped on every write (and read back via RETURNING onto the instance) so a
    // concurrent compareAndSwap can detect the row moved. A fresh insert starts at 0.
    const row = await this.db
      .prepare(
        `INSERT INTO agent_runs
           (workspace_id, id, kind, block_id, status, detail, created_at, updated_at,
            workflow_instance_id, service_id, rev)
         VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, ?,
            (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?), 0)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           block_id = excluded.block_id,
           status = excluded.status,
           detail = excluded.detail,
           updated_at = excluded.updated_at,
           service_id = excluded.service_id,
           rev = agent_runs.rev + 1
         RETURNING rev`,
      )
      .bind(
        workspaceId,
        execution.id,
        execution.blockId,
        execution.status,
        detail,
        createdAt,
        now,
        // Instance id == execution id today; stored for forward-compatibility.
        execution.id,
        workspaceId,
        execution.blockId,
      )
      .first<{ rev: number }>()
    if (row) execution.rev = row.rev
  }

  async insertLive(
    workspaceId: string,
    execution: ExecutionInstance,
    opts?: { replaceId?: string },
  ): Promise<boolean> {
    // One live run per block, enforced atomically by the partial unique index
    // `uniq_live_execution_per_block` (migration 0033) on (workspace_id, block_id) over live
    // execution rows. The cleanup and the insert run as ONE `db.batch` transaction so a losing
    // concurrent insert can never wipe the winner: the DELETE only ever removes the block's
    // TERMINAL rows and the caller's own `replaceId` (the run it is knowingly superseding) —
    // NEVER another writer's fresh live row — and the index then rejects a second live insert
    // via DO NOTHING (empty RETURNING). Callers therefore MUST NOT `deleteByBlock` first (an
    // unconditional pre-delete would remove a concurrent winner and re-open the race). The
    // ON CONFLICT target MUST mirror the index predicate exactly.
    const now = this.clock.now()
    const createdAt = adoptCreatedAt(execution, now)
    const detail = executionToDetail(execution)
    // `replaceId ?? null`: with no replaceId, `id = NULL` matches nothing, so only terminal
    // rows are cleared.
    const cleanup = this.db
      .prepare(
        `DELETE FROM agent_runs
         WHERE workspace_id = ? AND block_id = ? AND kind = 'execution'
           AND (status NOT IN ('running', 'blocked', 'paused') OR id = ?)`,
      )
      .bind(workspaceId, execution.blockId, opts?.replaceId ?? null)
    const insert = this.db
      .prepare(
        `INSERT INTO agent_runs
           (workspace_id, id, kind, block_id, status, detail, created_at, updated_at,
            workflow_instance_id, service_id, rev)
         VALUES (?, ?, 'execution', ?, ?, ?, ?, ?, ?,
            (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?), 0)
         ON CONFLICT (workspace_id, block_id)
           WHERE kind = 'execution' AND status IN ('running', 'blocked', 'paused')
           DO NOTHING
         RETURNING rev`,
      )
      .bind(
        workspaceId,
        execution.id,
        execution.blockId,
        execution.status,
        detail,
        createdAt,
        now,
        execution.id,
        workspaceId,
        execution.blockId,
      )
    // `db.batch` runs both statements sequentially in a single implicit transaction, so the
    // INSERT sees the DELETE's effect and the pair is atomic (all-or-nothing).
    const results = await this.db.batch<{ rev: number }>([cleanup, insert])
    const row = results[1]?.results?.[0]
    if (!row) return false
    execution.rev = row.rev
    return true
  }

  async compareAndSwap(workspaceId: string, execution: ExecutionInstance): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this instance; only writes
    // when the stored row is unchanged. No insert — the run must already exist.
    const expected = execution.rev ?? 0
    const detail = executionToDetail(execution)
    const now = this.clock.now()
    const row = await this.db
      .prepare(
        `UPDATE agent_runs SET
           block_id = ?,
           status = ?,
           detail = ?,
           updated_at = ?,
           service_id = (SELECT service_id FROM blocks WHERE workspace_id = ? AND id = ?),
           rev = rev + 1
         WHERE workspace_id = ? AND id = ? AND kind = 'execution' AND rev = ?
         RETURNING rev`,
      )
      .bind(
        execution.blockId,
        execution.status,
        detail,
        now,
        workspaceId,
        execution.blockId,
        workspaceId,
        execution.id,
        expected,
      )
      .first<{ rev: number }>()
    if (!row) return false
    execution.rev = row.rev
    return true
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .prepare(
        `DELETE FROM agent_runs WHERE workspace_id = ? AND block_id = ? AND kind = 'execution'`,
      )
      .bind(workspaceId, blockId)
      .run()
  }

  async listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const { results } = await this.db
      .prepare(
        `SELECT workspace_id, id FROM agent_runs
         WHERE kind = 'execution' AND status = 'running' AND updated_at < ?
         ORDER BY updated_at`,
      )
      .bind(olderThanEpochMs)
      .all<{ workspace_id: string; id: string }>()
    return results.map((r) => ({ workspaceId: r.workspace_id, id: r.id }))
  }

  async markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void> {
    // Guard against clobbering a row that already reached a terminal state: a `stopRun`
    // racing a run that just merged (`done`) or already failed must not overwrite it. This
    // is the authoritative first-write-wins / no-re-fail-a-merged-run check — `failRun`'s
    // in-memory guard reads a snapshot that can be stale by the time this write lands
    // (race-audit 2.3).
    //
    // BUMP `rev` on the terminal write so it participates in the driver's optimistic
    // concurrency: a `casPersist` from an in-flight driver iteration that loaded the run
    // BEFORE this `stopRun`/`failRun` still holds the pre-fail `rev`, so bumping it here makes
    // that stale write miss its `rev = ?` guard → `RunContendedError` → re-drive → the reload
    // sees `failed` and no-ops. Without the bump `markFailed` left `rev` untouched, so a stale
    // `casPersist` writing a non-terminal status (`pollGate` pending, dispatch, …) would MATCH
    // the unchanged `rev` and RESURRECT the stopped run as `running` (race-audit 2.3, the
    // driver-clobbers-terminal direction — the dual of the SQL status guard above).
    await this.db
      .prepare(
        `UPDATE agent_runs
           SET status = 'failed', error = ?, failure = ?, updated_at = ?, rev = rev + 1
         WHERE workspace_id = ? AND id = ? AND kind = 'execution'
           AND status NOT IN ('done', 'failed')`,
      )
      .bind(failure.message, JSON.stringify(failure), this.clock.now(), workspaceId, id)
      .run()
  }
}
