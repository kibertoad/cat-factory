// Drizzle/Postgres implementations of the core kernel repository ports, split by
// domain (mirrors the Cloudflare D1 per-repository layout). The row<->domain mapping
// is the SAME shared mapping the D1 repos use (@cat-factory/server), so behaviour
// matches across stores; this layer only owns the Drizzle queries. Assembled into the
// CoreRepositories set by ./drizzle.ts (the barrel).

import type {
  AgentFailure,
  AgentRunRef,
  AgentRunRepository,
  Clock,
  DueSchedule,
  ExecutionInstance,
  ExecutionRepository,
  ExecutionStatus,
  GateOutcomeRecord,
  GateOutcomeRepository,
  LiveRunSummary,
  Pipeline,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  PlatformDailyRunCount,
  PlatformDurationStats,
  PlatformFailedRunRef,
  PlatformFailureCount,
  PlatformGateOutcomeCount,
  PlatformLiveCounts,
  PlatformMetricsRepository,
  PlatformRunOutcome,
  PlatformRunTrendPoint,
  Recurrence,
  RunRef,
  ScheduleRun,
  ScheduleTemplate,
  StaleAgentRun,
} from '@cat-factory/kernel'
import { LIVE_EXECUTION_STATUSES } from '@cat-factory/kernel'
import { DAY_MS } from '@cat-factory/orchestration'
import { agentRunKindSchema } from '@cat-factory/contracts'
import type { ExecutionRow } from '@cat-factory/server'
import {
  adoptCreatedAt,
  decodeEnum,
  executionToDetail,
  parseIssueIntakeColumn,
  rowToExecution,
  rowToPipeline,
  serializeIssueIntakeColumn,
  tryDecodeRows,
} from '@cat-factory/server'
import { and, desc, eq, gte, inArray, lt, lte, notInArray, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentRuns,
  blocks,
  gateOutcomes,
  pipelineScheduleRuns,
  pipelineSchedules,
  pipelines,
  platformRunDays,
  workspaces,
} from '../../db/schema.js'

export class DrizzlePipelineRepository implements PipelineRepository {
  constructor(private readonly db: DrizzleDb) {}

  async listByWorkspace(workspaceId: string): Promise<Pipeline[]> {
    const rows = await this.db
      .select()
      .from(pipelines)
      .where(eq(pipelines.workspace_id, workspaceId))
      // Order by the monotonic insert `seq` so the catalog comes back in the curated
      // `seedPipelines()` order it was inserted in (Postgres gives no row order without
      // ORDER BY) — deterministic snapshots, a stable default `pipelines[0]`, and parity
      // with the Cloudflare facade's `ORDER BY rowid`.
      .orderBy(pipelines.seq)
    return rows.map(rowToPipeline)
  }

  async get(workspaceId: string, id: string): Promise<Pipeline | null> {
    const [row] = await this.db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, id)))
    return row ? rowToPipeline(row) : null
  }

  async insert(workspaceId: string, pipeline: Pipeline): Promise<void> {
    await this.db.insert(pipelines).values({
      workspace_id: workspaceId,
      id: pipeline.id,
      name: pipeline.name,
      description: pipeline.description ?? null,
      agent_kinds: JSON.stringify(pipeline.agentKinds),
      gates: pipeline.gates ? JSON.stringify(pipeline.gates) : null,
      thresholds: pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
      enabled: pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
      consensus: pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
      gating: pipeline.gating ? JSON.stringify(pipeline.gating) : null,
      follow_ups: pipeline.followUps ? JSON.stringify(pipeline.followUps) : null,
      tester_quality: pipeline.testerQuality ? JSON.stringify(pipeline.testerQuality) : null,
      step_options: pipeline.stepOptions ? JSON.stringify(pipeline.stepOptions) : null,
      labels: pipeline.labels ? JSON.stringify(pipeline.labels) : null,
      archived: pipeline.archived ? 1 : null,
      builtin: pipeline.builtin ? 1 : null,
      version: pipeline.version ?? null,
      public: pipeline.public ? 1 : null,
      availability: pipeline.availability ?? null,
      purpose: pipeline.purpose ?? null,
    })
  }

  async update(workspaceId: string, pipeline: Pipeline): Promise<void> {
    // UPDATE in place preserves the row's `seq`, so an edited pipeline keeps its place
    // in the catalog order. `builtin` is immutable, so it is not rewritten. `version` IS
    // rewritten so a reseed bumps the stored copy to the current catalog version.
    await this.db
      .update(pipelines)
      .set({
        name: pipeline.name,
        description: pipeline.description ?? null,
        agent_kinds: JSON.stringify(pipeline.agentKinds),
        gates: pipeline.gates ? JSON.stringify(pipeline.gates) : null,
        thresholds: pipeline.thresholds ? JSON.stringify(pipeline.thresholds) : null,
        enabled: pipeline.enabled ? JSON.stringify(pipeline.enabled) : null,
        consensus: pipeline.consensus ? JSON.stringify(pipeline.consensus) : null,
        gating: pipeline.gating ? JSON.stringify(pipeline.gating) : null,
        follow_ups: pipeline.followUps ? JSON.stringify(pipeline.followUps) : null,
        tester_quality: pipeline.testerQuality ? JSON.stringify(pipeline.testerQuality) : null,
        step_options: pipeline.stepOptions ? JSON.stringify(pipeline.stepOptions) : null,
        labels: pipeline.labels ? JSON.stringify(pipeline.labels) : null,
        archived: pipeline.archived ? 1 : null,
        version: pipeline.version ?? null,
        public: pipeline.public ? 1 : null,
        availability: pipeline.availability ?? null,
        purpose: pipeline.purpose ?? null,
      })
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, pipeline.id)))
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(pipelines)
      .where(and(eq(pipelines.workspace_id, workspaceId), eq(pipelines.id, id)))
  }
}

/** Execution runs live as `kind='execution'` rows of the unified agent_runs table. */

export class DrizzleExecutionRepository implements ExecutionRepository {
  constructor(
    private readonly db: DrizzleDb,
    private readonly clock: Clock,
  ) {}

  private readonly isExecution = eq(agentRuns.kind, 'execution')
  // The live-run predicate, shared by the `listLive` projection and the admission-control
  // capacity COUNT so the two cannot drift. `insertLive` deliberately keeps its literals: those
  // mirror the frozen index predicate (see LIVE_EXECUTION_STATUSES).
  private readonly isLive = inArray(agentRuns.status, [...LIVE_EXECUTION_STATUSES])

  async listByWorkspace(workspaceId: string): Promise<ExecutionInstance[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), this.isExecution))
      .orderBy(agentRuns.created_at)
    // Snapshot-facing list read: drop a corrupt run rather than failing the whole board load.
    return tryDecodeRows(
      rows,
      (r) => rowToExecution(r as ExecutionRow),
      (r) => ({ table: 'agent_runs', id: (r as ExecutionRow).id }),
    )
  }

  async listLive(workspaceId: string): Promise<LiveRunSummary[]> {
    // Lean live-run projection: block_id + status + id only, NEVER the heavy `detail` column.
    // Served by idx_agent_runs_ws_kind_status (workspace_id, kind, status). Mirrors the D1 repo.
    // Unordered: both consumers (dispatch guard's block-id Set, resumePaused's id loop) are
    // order-agnostic.
    const rows = await this.db
      .select({ id: agentRuns.id, blockId: agentRuns.block_id, status: agentRuns.status })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), this.isExecution, this.isLive))
    return rows.map((r) => ({
      id: r.id,
      blockId: r.blockId ?? '',
      status: r.status as LiveRunSummary['status'],
    }))
  }

  async countActiveByWorkspace(workspaceId: string): Promise<number> {
    // Admission-control capacity read: the COUNT is pushed into SQL (never rows reduced in JS),
    // over the same live predicate and index as `listLive` above. Mirrors the D1 repo.
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), this.isExecution, this.isLive))
    return row?.n ?? 0
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
    // never leak into the public job list. Mirrors the D1 repo (same predicates, same ordering).
    const filters = [
      eq(agentRuns.workspace_id, workspaceId),
      this.isExecution,
      eq(blocks.internal, 1),
    ]
    if (opts.statuses && opts.statuses.length > 0) {
      filters.push(inArray(agentRuns.status, opts.statuses))
    }
    if (opts.since != null) filters.push(gte(agentRuns.created_at, opts.since))
    if (opts.cursor) {
      // Composite keyset matching the ORDER BY, so rows sharing a `created_at` are not skipped.
      const cursor = opts.cursor
      filters.push(
        or(
          lt(agentRuns.created_at, cursor.createdAt),
          and(eq(agentRuns.created_at, cursor.createdAt), lt(agentRuns.id, cursor.id)),
        )!,
      )
    }
    const rows = await this.db
      .select({ run: agentRuns })
      .from(agentRuns)
      .innerJoin(
        blocks,
        and(eq(blocks.workspace_id, agentRuns.workspace_id), eq(blocks.id, agentRuns.block_id)),
      )
      .where(and(...filters))
      .orderBy(desc(agentRuns.created_at), desc(agentRuns.id))
      .limit(opts.limit)
    // List read: drop a corrupt run rather than failing the whole page.
    return tryDecodeRows(
      rows.map((r) => r.run),
      (r) => rowToExecution(r as ExecutionRow),
      (r) => ({ table: 'agent_runs', id: (r as ExecutionRow).id }),
    )
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
    // run index deliberately spans every run in the workspace (see the port). Mirrors the D1 repo.
    const filters = [eq(agentRuns.workspace_id, workspaceId), this.isExecution]
    if (opts.statuses && opts.statuses.length > 0) {
      filters.push(inArray(agentRuns.status, opts.statuses))
    }
    if (opts.since != null) filters.push(gte(agentRuns.created_at, opts.since))
    if (opts.cursor) {
      const cursor = opts.cursor
      filters.push(
        or(
          lt(agentRuns.created_at, cursor.createdAt),
          and(eq(agentRuns.created_at, cursor.createdAt), lt(agentRuns.id, cursor.id)),
        )!,
      )
    }
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(...filters))
      .orderBy(desc(agentRuns.created_at), desc(agentRuns.id))
      .limit(opts.limit)
    // List read: drop a corrupt run rather than failing the whole page. Note the interaction
    // with the caller's peek-one-extra pagination: a dropped row shrinks the page below
    // `limit + 1`, so a page containing a corrupt run reads as the LAST page and later rows
    // become unreachable until the row is repaired — accepted, matching every other list read.
    return tryDecodeRows(
      rows,
      (r) => rowToExecution(r as ExecutionRow),
      (r) => ({ table: 'agent_runs', id: (r as ExecutionRow).id }),
    )
  }

  async listByService(serviceId: string): Promise<ExecutionInstance[]> {
    const rows = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.service_id, serviceId), this.isExecution))
      .orderBy(agentRuns.created_at)
    return tryDecodeRows(
      rows,
      (r) => rowToExecution(r as ExecutionRow),
      (r) => ({ table: 'agent_runs', id: (r as ExecutionRow).id }),
    )
  }

  async listByServices(serviceIds: string[]): Promise<ExecutionInstance[]> {
    if (serviceIds.length === 0) return []
    const out: ExecutionInstance[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(agentRuns)
        .where(and(inArray(agentRuns.service_id, serviceIds.slice(i, i + 500)), this.isExecution))
        .orderBy(agentRuns.created_at)
      out.push(
        ...tryDecodeRows(
          rows,
          (r) => rowToExecution(r as ExecutionRow),
          (r) => ({ table: 'agent_runs', id: (r as ExecutionRow).id }),
        ),
      )
    }
    return out
  }

  async exists(workspaceId: string, id: string): Promise<boolean> {
    // One indexed probe, no row decode (see the port). Mirrors the D1 repo.
    const rows = await this.db
      .select({ one: sql<number>`1` })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id), this.isExecution))
      .limit(1)
    return rows.length > 0
  }

  async get(workspaceId: string, id: string): Promise<ExecutionInstance | null> {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id), this.isExecution))
    return row ? rowToExecution(row as ExecutionRow) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<ExecutionInstance | null> {
    const [row] = await this.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.block_id, blockId),
          this.isExecution,
        ),
      )
    return row ? rowToExecution(row as ExecutionRow) : null
  }

  async upsert(workspaceId: string, execution: ExecutionInstance): Promise<void> {
    const now = this.clock.now()
    const createdAt = adoptCreatedAt(execution, now)
    const detail = executionToDetail(execution)
    // Stamp `service_id` from the run's block (subquery) so a shared service's runs surface on
    // every board that mounts it via `listByService`; refreshed on every write so it follows a
    // reparent that re-homes the block. Mirrors the D1 repo.
    const serviceIdSub = sql`(SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${workspaceId} AND ${blocks.id} = ${execution.blockId})`
    // `rev` is bumped on every write (and read back onto the instance) so a concurrent
    // compareAndSwap can detect the row moved. A fresh insert starts at 0.
    const rows = await this.db
      .insert(agentRuns)
      .values({
        workspace_id: workspaceId,
        id: execution.id,
        kind: 'execution',
        block_id: execution.blockId,
        status: execution.status,
        detail,
        created_at: createdAt,
        updated_at: now,
        workflow_instance_id: execution.id,
        service_id: serviceIdSub,
        rev: 0,
      })
      // error/failure/workflow_instance_id are left out of the update so they survive
      // normal step writes (see markFailed) — mirrors the D1 repo.
      .onConflictDoUpdate({
        target: [agentRuns.workspace_id, agentRuns.id],
        set: {
          block_id: execution.blockId,
          status: execution.status,
          detail,
          updated_at: now,
          service_id: serviceIdSub,
          rev: sql`${agentRuns.rev} + 1`,
        },
      })
      .returning({ rev: agentRuns.rev })
    if (rows[0]) execution.rev = rows[0].rev
  }

  async insertLive(
    workspaceId: string,
    execution: ExecutionInstance,
    opts?: { replaceId?: string },
  ): Promise<boolean> {
    // One live run per block, enforced atomically by the partial unique index
    // `uniq_live_execution_per_block` on (workspace_id, block_id) over live execution rows. The
    // cleanup and the insert run inside ONE transaction so a losing concurrent insert can never
    // wipe the winner: the DELETE only ever removes the block's TERMINAL rows and the caller's
    // own `replaceId` (the run it is knowingly superseding) — NEVER another writer's fresh live
    // row — and the index then rejects a second live insert via DO NOTHING (empty returning).
    // Callers therefore MUST NOT `deleteByBlock` first. The conflict target mirrors the D1 repo
    // and the index predicate exactly; the insert columns mirror upsert (service_id subquery,
    // rev 0).
    const now = this.clock.now()
    const createdAt = adoptCreatedAt(execution, now)
    const detail = executionToDetail(execution)
    const serviceIdSub = sql`(SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${workspaceId} AND ${blocks.id} = ${execution.blockId})`
    const terminalOrReplaced = opts?.replaceId
      ? or(
          notInArray(agentRuns.status, ['running', 'blocked', 'paused']),
          eq(agentRuns.id, opts.replaceId),
        )
      : notInArray(agentRuns.status, ['running', 'blocked', 'paused'])
    const rows = await this.db.transaction(async (tx) => {
      await tx
        .delete(agentRuns)
        .where(
          and(
            eq(agentRuns.workspace_id, workspaceId),
            eq(agentRuns.block_id, execution.blockId),
            eq(agentRuns.kind, 'execution'),
            terminalOrReplaced,
          ),
        )
      return tx
        .insert(agentRuns)
        .values({
          workspace_id: workspaceId,
          id: execution.id,
          kind: 'execution',
          block_id: execution.blockId,
          status: execution.status,
          detail,
          created_at: createdAt,
          updated_at: now,
          workflow_instance_id: execution.id,
          service_id: serviceIdSub,
          rev: 0,
        })
        .onConflictDoNothing({
          target: [agentRuns.workspace_id, agentRuns.block_id],
          // For DO NOTHING, `where` is the conflict target's partial-index predicate (the
          // DO-UPDATE `targetWhere`); it must mirror uniq_live_execution_per_block exactly.
          where: sql`${agentRuns.kind} = 'execution' AND ${agentRuns.status} IN ('running', 'blocked', 'paused')`,
        })
        .returning({ rev: agentRuns.rev })
    })
    if (!rows[0]) return false
    execution.rev = rows[0].rev
    return true
  }

  async compareAndSwap(workspaceId: string, execution: ExecutionInstance): Promise<boolean> {
    // Conditional update guarded on the rev last read onto this instance; only writes
    // when the stored row is unchanged. No insert — the run must already exist.
    const expected = execution.rev ?? 0
    const now = this.clock.now()
    const detail = executionToDetail(execution)
    const serviceIdSub = sql`(SELECT ${blocks.service_id} FROM ${blocks} WHERE ${blocks.workspace_id} = ${workspaceId} AND ${blocks.id} = ${execution.blockId})`
    const rows = await this.db
      .update(agentRuns)
      .set({
        block_id: execution.blockId,
        status: execution.status,
        detail,
        updated_at: now,
        service_id: serviceIdSub,
        rev: sql`${agentRuns.rev} + 1`,
      })
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.id, execution.id),
          this.isExecution,
          eq(agentRuns.rev, expected),
        ),
      )
      .returning({ rev: agentRuns.rev })
    if (!rows[0]) return false
    execution.rev = rows[0].rev
    return true
  }

  async deleteByBlock(workspaceId: string, blockId: string): Promise<void> {
    await this.db
      .delete(agentRuns)
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.block_id, blockId),
          this.isExecution,
        ),
      )
  }

  async listStale(olderThanEpochMs: number): Promise<RunRef[]> {
    const rows = await this.db
      .select({ workspaceId: agentRuns.workspace_id, id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          this.isExecution,
          eq(agentRuns.status, 'running'),
          lt(agentRuns.updated_at, olderThanEpochMs),
        ),
      )
      .orderBy(agentRuns.updated_at)
    return rows
  }

  async markFailed(workspaceId: string, id: string, failure: AgentFailure): Promise<void> {
    // Guard against clobbering a row that already reached a terminal state: a `stopRun`
    // racing a run that just merged (`done`) or already failed must not overwrite it. This
    // is the authoritative first-write-wins / no-re-fail-a-merged-run check — `failRun`'s
    // in-memory guard reads a snapshot that can be stale by the time this write lands
    // (race-audit 2.3). Mirrors the D1 `AND status NOT IN ('done','failed')`.
    //
    // BUMP `rev` on the terminal write so it participates in the driver's optimistic
    // concurrency: a `casPersist` from an in-flight driver iteration that loaded the run
    // BEFORE this `stopRun`/`failRun` still holds the pre-fail `rev`, so bumping it here makes
    // that stale write miss its `rev = ?` guard → `RunContendedError` → re-drive → the reload
    // sees `failed` and no-ops. Without the bump `markFailed` left `rev` untouched, so a stale
    // `casPersist` writing a non-terminal status (`pollGate` pending, dispatch, …) would MATCH
    // the unchanged `rev` and RESURRECT the stopped run as `running` (race-audit 2.3, the
    // driver-clobbers-terminal direction — the dual of the SQL status guard above). Mirrors the
    // D1 `rev = rev + 1`.
    await this.db
      .update(agentRuns)
      .set({
        status: 'failed',
        error: failure.message,
        failure: JSON.stringify(failure),
        updated_at: this.clock.now(),
        rev: sql`${agentRuns.rev} + 1`,
      })
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          eq(agentRuns.id, id),
          this.isExecution,
          notInArray(agentRuns.status, ['done', 'failed']),
        ),
      )
  }
}

export class DrizzleAgentRunRepository implements AgentRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async getRef(workspaceId: string, id: string): Promise<AgentRunRef | null> {
    const [row] = await this.db
      .select({ kind: agentRuns.kind })
      .from(agentRuns)
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id)))
    return row
      ? {
          workspaceId,
          id,
          kind: decodeEnum(agentRunKindSchema, row.kind, {
            table: 'agent_runs',
            column: 'kind',
            id,
          }),
        }
      : null
  }

  async listStale(olderThanEpochMs: number): Promise<StaleAgentRun[]> {
    const rows = await this.db
      .select({
        workspaceId: agentRuns.workspace_id,
        id: agentRuns.id,
        kind: agentRuns.kind,
        updatedAt: agentRuns.updated_at,
        redriveCount: agentRuns.redrive_count,
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.updated_at, olderThanEpochMs)))
      .orderBy(agentRuns.updated_at)
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      id: r.id,
      updatedAt: r.updatedAt,
      redriveCount: r.redriveCount ?? 0,
      kind: decodeEnum(agentRunKindSchema, r.kind, {
        table: 'agent_runs',
        column: 'kind',
        id: r.id,
      }),
    }))
  }

  async listPausedExecutions(): Promise<AgentRunRef[]> {
    const rows = await this.db
      .select({ workspaceId: agentRuns.workspace_id, id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.kind, 'execution'), eq(agentRuns.status, 'paused')))
      .orderBy(agentRuns.updated_at)
    return rows.map((r) => ({ workspaceId: r.workspaceId, id: r.id, kind: 'execution' as const }))
  }

  async liveRunIds(ids: string[]): Promise<string[]> {
    if (ids.length === 0) return []
    const live: string[] = []
    // Chunk the IN list (batch, not a point-read per id) so a large set stays one query each.
    for (let i = 0; i < ids.length; i += 500) {
      const rows = await this.db
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            inArray(agentRuns.status, ['running', 'blocked', 'paused', 'pending']),
            inArray(agentRuns.id, ids.slice(i, i + 500)),
          ),
        )
      for (const r of rows) live.push(r.id)
    }
    return live
  }

  async recordRedrive(workspaceId: string, id: string): Promise<number> {
    // One statement: increment and read back the new total, so nothing races between a read
    // and a write. The row is absent (0 returned) only for a run that has since been deleted.
    const rows = await this.db
      .update(agentRuns)
      .set({ redrive_count: sql`${agentRuns.redrive_count} + 1` })
      .where(and(eq(agentRuns.workspace_id, workspaceId), eq(agentRuns.id, id)))
      .returning({ redriveCount: agentRuns.redrive_count })
    return rows[0]?.redriveCount ?? 0
  }
}

/**
 * Deployment-level rollups over `agent_runs`, scoped to an account by a sub-select on
 * `workspaces` (both main-DB tables). Every method is one aggregate query — no row is
 * loaded to be reduced in JS. Mirrors `D1PlatformMetricsRepository`; the cross-runtime
 * conformance suite asserts the two agree.
 */
export class DrizzlePlatformMetricsRepository implements PlatformMetricsRepository {
  constructor(private readonly db: DrizzleDb) {}

  /** `agent_runs.workspace_id ∈ the account's workspaces` — the account scope for every query. */
  private accountScope(accountId: string) {
    return inArray(
      agentRuns.workspace_id,
      this.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.account_id, accountId)),
    )
  }

  async runOutcomesSince(accountId: string, sinceEpochMs: number): Promise<PlatformRunOutcome[]> {
    const rows = await this.db
      .select({ kind: agentRuns.kind, status: agentRuns.status, count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(this.accountScope(accountId), gte(agentRuns.created_at, sinceEpochMs)))
      .groupBy(agentRuns.kind, agentRuns.status)
    return rows.map((r) => ({
      kind: decodeEnum(agentRunKindSchema, r.kind, { table: 'agent_runs', column: 'kind', id: '' }),
      status: r.status,
      count: Number(r.count),
    }))
  }

  async runOutcomeTrend(
    accountId: string,
    sinceEpochMs: number,
    bucketMs: number,
  ): Promise<PlatformRunTrendPoint[]> {
    // Alias the bucket expression and GROUP BY / ORDER BY the alias, NOT the raw fragment:
    // Drizzle re-emits an inline `sql` expression with fresh bind-parameter placeholders in
    // each clause (SELECT `$1,$2` vs GROUP BY `$5,$6`), and Postgres matches GROUP BY columns
    // to the SELECT list by parse-tree identity — distinct placeholders read as different
    // expressions and it rejects the query with 42803. Referencing the output name sidesteps
    // that. (SQLite is lenient here, so the D1 repo works with the inline form.)
    const bucket =
      sql<number>`((${agentRuns.created_at} / ${bucketMs}::bigint) * ${bucketMs}::bigint)`.as(
        'bucket_start',
      )
    const rows = await this.db
      .select({ bucketStart: bucket, status: agentRuns.status, count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(and(this.accountScope(accountId), gte(agentRuns.created_at, sinceEpochMs)))
      .groupBy(sql`bucket_start`, agentRuns.status)
      .orderBy(sql`bucket_start`)
    return rows.map((r) => ({
      bucketStart: Number(r.bucketStart),
      status: r.status,
      count: Number(r.count),
    }))
  }

  async failureKindBreakdown(
    accountId: string,
    sinceEpochMs: number,
  ): Promise<PlatformFailureCount[]> {
    const failureKind = sql<string>`coalesce((${agentRuns.failure}::jsonb ->> 'kind'), 'unknown')`
    const rows = await this.db
      .select({ failureKind, count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          this.accountScope(accountId),
          gte(agentRuns.created_at, sinceEpochMs),
          eq(agentRuns.status, 'failed'),
        ),
      )
      .groupBy(failureKind)
      .orderBy(desc(sql`count(*)`))
    return rows.map((r) => ({ failureKind: r.failureKind, count: Number(r.count) }))
  }

  async activeAndParkedCounts(accountId: string): Promise<PlatformLiveCounts> {
    const rows = await this.db
      .select({ status: agentRuns.status, count: sql<number>`count(*)::int` })
      .from(agentRuns)
      .where(
        and(
          this.accountScope(accountId),
          inArray(agentRuns.status, ['running', 'blocked', 'paused', 'pending']),
        ),
      )
      .groupBy(agentRuns.status)
    const counts: PlatformLiveCounts = { running: 0, blocked: 0, paused: 0, pending: 0 }
    for (const r of rows) {
      if (r.status in counts) counts[r.status as keyof PlatformLiveCounts] = Number(r.count)
    }
    return counts
  }

  async durationStatsSince(
    accountId: string,
    sinceEpochMs: number,
  ): Promise<PlatformDurationStats> {
    const delta = sql`(${agentRuns.updated_at} - ${agentRuns.created_at})`
    // avg/min/max AND the p50/p90/p99 percentiles over ONE scan of the same terminal-run set.
    // `percentile_disc` is the DISCRETE (nearest-rank) percentile — it returns an actual member
    // duration, matching the D1/SQLite `row_number()/count()` cumulative-fraction workaround
    // (SQLite has no percentile aggregate); the conformance suite pins that the two agree.
    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        avgMs: sql<number | null>`avg(${delta})::float8`,
        minMs: sql<number | null>`min(${delta})`,
        maxMs: sql<number | null>`max(${delta})`,
        p50Ms: sql<number | null>`percentile_disc(0.5) within group (order by ${delta})`,
        p90Ms: sql<number | null>`percentile_disc(0.9) within group (order by ${delta})`,
        p99Ms: sql<number | null>`percentile_disc(0.99) within group (order by ${delta})`,
      })
      .from(agentRuns)
      .where(
        and(
          this.accountScope(accountId),
          gte(agentRuns.created_at, sinceEpochMs),
          inArray(agentRuns.status, ['done', 'failed']),
        ),
      )
    const count = Number(row?.count ?? 0)
    const at = (v: number | null | undefined) => (count > 0 && v != null ? Number(v) : null)
    return {
      count,
      avgMs: count > 0 && row?.avgMs != null ? Math.round(Number(row.avgMs)) : null,
      minMs: at(row?.minMs),
      maxMs: at(row?.maxMs),
      p50Ms: at(row?.p50Ms),
      p90Ms: at(row?.p90Ms),
      p99Ms: at(row?.p99Ms),
    }
  }

  async rollupRunDays(fromEpochMs: number, toEpochMs: number): Promise<number> {
    // One `INSERT … SELECT … GROUP BY`: the aggregation happens in Postgres and no run row is
    // loaded. Bounds snap to day edges so a partially-covered day is never written with only
    // the covered part's counts, which would then read as a complete day.
    const from = Math.floor(fromEpochMs / DAY_MS) * DAY_MS
    const to = Math.ceil(toEpochMs / DAY_MS) * DAY_MS
    if (to <= from) return 0
    // DO UPDATE, not DO NOTHING: the current day is still accruing, so each pass CORRECTS its
    // bucket. `failure_kind` is '' for a non-failed status because it is in the primary key
    // (see migration 0078 for why a nullable key column would not deduplicate).
    const res = await this.db.execute(sql`
      INSERT INTO platform_run_days (workspace_id, day_start, status, failure_kind, run_count)
      SELECT ${agentRuns.workspace_id},
             (${agentRuns.created_at} / ${DAY_MS}::bigint) * ${DAY_MS}::bigint AS day_start,
             ${agentRuns.status},
             CASE WHEN ${agentRuns.status} = 'failed'
                  THEN coalesce((${agentRuns.failure}::jsonb ->> 'kind'), 'unknown')
                  ELSE '' END AS failure_kind,
             count(*)::int AS run_count
      FROM ${agentRuns}
      WHERE ${agentRuns.created_at} >= ${from} AND ${agentRuns.created_at} < ${to}
      GROUP BY 1, 2, 3, 4
      ON CONFLICT (workspace_id, day_start, status, failure_kind)
        DO UPDATE SET run_count = excluded.run_count
    `)
    return Number(res.rowCount ?? 0)
  }

  async dailyRunTotalsSince(
    accountId: string,
    sinceEpochMs: number,
  ): Promise<PlatformDailyRunCount[]> {
    const rows = await this.db
      .select({
        dayStart: platformRunDays.day_start,
        status: platformRunDays.status,
        failureKind: platformRunDays.failure_kind,
        count: sql<number>`sum(${platformRunDays.run_count})::int`,
      })
      .from(platformRunDays)
      .where(
        and(
          inArray(
            platformRunDays.workspace_id,
            this.db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.account_id, accountId)),
          ),
          // Snap to the day the window starts IN, so a window beginning mid-day still includes
          // that day's bucket rather than dropping the oldest day entirely.
          gte(platformRunDays.day_start, Math.floor(sinceEpochMs / DAY_MS) * DAY_MS),
        ),
      )
      .groupBy(platformRunDays.day_start, platformRunDays.status, platformRunDays.failure_kind)
      .orderBy(platformRunDays.day_start)
    return rows.map((r) => ({
      dayStart: Number(r.dayStart),
      status: r.status,
      failureKind: r.failureKind === '' ? null : r.failureKind,
      count: Number(r.count),
    }))
  }

  async dailyRollupWatermark(accountId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ dayStart: sql<number | null>`max(${platformRunDays.day_start})` })
      .from(platformRunDays)
      .where(
        inArray(
          platformRunDays.workspace_id,
          this.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.account_id, accountId)),
        ),
      )
    return row?.dayStart != null ? Number(row.dayStart) : null
  }

  async deleteRunDaysOlderThan(cutoff: number): Promise<number> {
    const rows = await this.db
      .delete(platformRunDays)
      .where(lt(platformRunDays.day_start, cutoff))
      .returning({ dayStart: platformRunDays.day_start })
    return rows.length
  }

  async recentFailedRuns(
    accountId: string,
    sinceEpochMs: number,
    perWorkspaceLimit: number,
  ): Promise<PlatformFailedRunRef[]> {
    if (perWorkspaceLimit <= 0) return []
    // Capped PER WORKSPACE by a window function rather than one global LIMIT: a card belongs to
    // a single workspace, and a noisy neighbour must not starve another's card of its evidence.
    // The partition COUNT rides along so the cap can state what it left out without a second
    // query that could disagree with the sample it accompanies.
    const ranked = this.db
      .select({
        workspaceId: agentRuns.workspace_id,
        executionId: agentRuns.id,
        blockId: agentRuns.block_id,
        createdAt: agentRuns.created_at,
        failureKind: sql<string>`coalesce((${agentRuns.failure}::jsonb ->> 'kind'), 'unknown')`.as(
          'failure_kind',
        ),
        rn: sql<number>`row_number() over (partition by ${agentRuns.workspace_id}
              order by ${agentRuns.created_at} desc, ${agentRuns.id} desc)`.as('rn'),
        workspaceFailedTotal:
          sql<number>`(count(*) over (partition by ${agentRuns.workspace_id}))::int`.as(
            'workspace_failed_total',
          ),
      })
      .from(agentRuns)
      .where(
        and(
          this.accountScope(accountId),
          gte(agentRuns.created_at, sinceEpochMs),
          eq(agentRuns.status, 'failed'),
          eq(agentRuns.kind, 'execution'),
        ),
      )
      .as('ranked')
    const rows = await this.db
      .select({
        workspaceId: ranked.workspaceId,
        executionId: ranked.executionId,
        blockId: ranked.blockId,
        failureKind: ranked.failureKind,
        createdAt: ranked.createdAt,
        workspaceFailedTotal: ranked.workspaceFailedTotal,
      })
      .from(ranked)
      .where(lte(ranked.rn, perWorkspaceLimit))
      .orderBy(ranked.workspaceId, desc(ranked.createdAt))
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      executionId: r.executionId,
      blockId: r.blockId ?? null,
      failureKind: r.failureKind,
      createdAt: Number(r.createdAt),
      workspaceFailedTotal: Number(r.workspaceFailedTotal),
    }))
  }
}

/**
 * The settled-gate projection on Postgres: the engine's write and the ONE aggregate behind the
 * dashboard's gate / CI-fixer attempt statistics. Mirrors `D1GateOutcomeRepository`; the
 * cross-runtime conformance suite asserts the two agree.
 */
export class DrizzleGateOutcomeRepository implements GateOutcomeRepository {
  constructor(private readonly db: DrizzleDb) {}

  async record(row: GateOutcomeRecord): Promise<void> {
    // FIRST WRITE WINS on the derived id: the durable drivers replay, and re-inserting a settle
    // would inflate every count this table exists to report.
    await this.db
      .insert(gateOutcomes)
      .values({
        id: row.id,
        workspace_id: row.workspaceId,
        execution_id: row.executionId,
        block_id: row.blockId,
        gate_kind: row.gateKind,
        helper_kind: row.helperKind,
        outcome: row.outcome,
        attempts: row.attempts,
        max_attempts: row.maxAttempts,
        helper_failures: row.helperFailures,
        duration_ms: row.durationMs,
        created_at: row.createdAt,
      })
      .onConflictDoNothing({ target: gateOutcomes.id })
  }

  async statsSince(accountId: string, sinceEpochMs: number): Promise<PlatformGateOutcomeCount[]> {
    const gates = sql<number>`count(*)::int`
    const rows = await this.db
      .select({
        gateKind: gateOutcomes.gate_kind,
        helperKind: gateOutcomes.helper_kind,
        outcome: gateOutcomes.outcome,
        gates,
        attempts: sql<number>`coalesce(sum(${gateOutcomes.attempts}), 0)::int`,
        helperFailures: sql<number>`coalesce(sum(${gateOutcomes.helper_failures}), 0)::int`,
        cleanGates: sql<number>`count(*) filter (where ${gateOutcomes.attempts} = 0)::int`,
      })
      .from(gateOutcomes)
      .where(
        and(
          inArray(
            gateOutcomes.workspace_id,
            this.db
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(eq(workspaces.account_id, accountId)),
          ),
          gte(gateOutcomes.created_at, sinceEpochMs),
        ),
      )
      .groupBy(gateOutcomes.gate_kind, gateOutcomes.helper_kind, gateOutcomes.outcome)
      .orderBy(desc(sql`count(*)`))
    return rows.map((r) => ({
      gateKind: r.gateKind,
      helperKind: r.helperKind ?? null,
      // Guard the stored string into the port's union; anything unrecognised reads as the
      // non-passing outcome rather than being dropped from the statistic entirely.
      outcome: r.outcome === 'passed' ? ('passed' as const) : ('exhausted' as const),
      gates: Number(r.gates),
      attempts: Number(r.attempts),
      helperFailures: Number(r.helperFailures),
      cleanGates: Number(r.cleanGates),
    }))
  }

  async deleteOlderThan(cutoff: number): Promise<number> {
    const rows = await this.db
      .delete(gateOutcomes)
      .where(lt(gateOutcomes.created_at, cutoff))
      .returning({ id: gateOutcomes.id })
    return rows.length
  }
}

type ScheduleRow = typeof pipelineSchedules.$inferSelect

type RunRow = typeof pipelineScheduleRuns.$inferSelect

function rowToSchedule(row: ScheduleRow): PipelineSchedule {
  const recurrence: Recurrence = {
    intervalHours: row.interval_hours,
    weekdays: safeWeekdays(row.weekdays),
    windowStartHour: row.window_start_hour,
    windowEndHour: row.window_end_hour,
    timezone: row.timezone,
  }
  const issueIntake = parseIssueIntakeColumn(row.issue_intake)
  return {
    id: row.id,
    serviceId: row.service_id,
    blockId: row.block_id,
    frameId: row.frame_id,
    pipelineId: row.pipeline_id,
    template: row.template as ScheduleTemplate,
    name: row.name,
    recurrence,
    onDemand: row.on_demand === 1,
    ...(issueIntake ? { issueIntake } : {}),
    enabled: row.enabled === 1,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
  }
}

function safeWeekdays(value: string): number[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === 'number') : []
  } catch {
    return []
  }
}

function rowToRun(row: RunRow): ScheduleRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    executionId: row.execution_id,
    status: row.status as ScheduleRun['status'],
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    outcome: row.outcome,
  }
}

export class DrizzlePipelineScheduleRepository implements PipelineScheduleRepository {
  constructor(private readonly db: DrizzleDb) {}

  private values(workspaceId: string, schedule: PipelineSchedule) {
    const r = schedule.recurrence
    return {
      workspace_id: workspaceId,
      id: schedule.id,
      service_id: schedule.serviceId,
      block_id: schedule.blockId,
      frame_id: schedule.frameId,
      pipeline_id: schedule.pipelineId,
      template: schedule.template,
      name: schedule.name,
      interval_hours: r.intervalHours,
      weekdays: JSON.stringify(r.weekdays),
      window_start_hour: r.windowStartHour,
      window_end_hour: r.windowEndHour,
      timezone: r.timezone,
      enabled: schedule.enabled ? 1 : 0,
      on_demand: schedule.onDemand ? 1 : 0,
      issue_intake: serializeIssueIntakeColumn(schedule.issueIntake),
      last_run_at: schedule.lastRunAt,
      next_run_at: schedule.nextRunAt,
      created_at: schedule.createdAt,
    }
  }

  async get(workspaceId: string, id: string): Promise<PipelineSchedule | null> {
    const [row] = await this.db
      .select()
      .from(pipelineSchedules)
      .where(and(eq(pipelineSchedules.workspace_id, workspaceId), eq(pipelineSchedules.id, id)))
    return row ? rowToSchedule(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<PipelineSchedule | null> {
    const [row] = await this.db
      .select()
      .from(pipelineSchedules)
      .where(
        and(
          eq(pipelineSchedules.workspace_id, workspaceId),
          eq(pipelineSchedules.block_id, blockId),
        ),
      )
    return row ? rowToSchedule(row) : null
  }

  async list(workspaceId: string): Promise<PipelineSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(eq(pipelineSchedules.workspace_id, workspaceId))
      .orderBy(pipelineSchedules.created_at)
    return rows.map(rowToSchedule)
  }

  async listByService(serviceId: string): Promise<PipelineSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(eq(pipelineSchedules.service_id, serviceId))
      .orderBy(pipelineSchedules.created_at)
    return rows.map(rowToSchedule)
  }

  async listByServices(serviceIds: string[]): Promise<PipelineSchedule[]> {
    if (serviceIds.length === 0) return []
    const out: PipelineSchedule[] = []
    // Chunk the IN list to stay well under the bind-parameter limit.
    for (let i = 0; i < serviceIds.length; i += 500) {
      const rows = await this.db
        .select()
        .from(pipelineSchedules)
        .where(inArray(pipelineSchedules.service_id, serviceIds.slice(i, i + 500)))
        .orderBy(pipelineSchedules.created_at)
      for (const row of rows) out.push(rowToSchedule(row))
    }
    return out
  }

  async listDue(asOf: number): Promise<DueSchedule[]> {
    const rows = await this.db
      .select()
      .from(pipelineSchedules)
      .where(
        and(
          eq(pipelineSchedules.enabled, 1),
          eq(pipelineSchedules.on_demand, 0),
          lt(pipelineSchedules.next_run_at, asOf + 1),
        ),
      )
      .orderBy(pipelineSchedules.next_run_at)
    return rows.map((row) => ({ workspaceId: row.workspace_id, schedule: rowToSchedule(row) }))
  }

  async upsert(workspaceId: string, schedule: PipelineSchedule): Promise<void> {
    const values = this.values(workspaceId, schedule)
    await this.db
      .insert(pipelineSchedules)
      .values(values)
      .onConflictDoUpdate({
        target: [pipelineSchedules.workspace_id, pipelineSchedules.id],
        set: {
          service_id: values.service_id,
          block_id: values.block_id,
          frame_id: values.frame_id,
          pipeline_id: values.pipeline_id,
          template: values.template,
          name: values.name,
          interval_hours: values.interval_hours,
          weekdays: values.weekdays,
          window_start_hour: values.window_start_hour,
          window_end_hour: values.window_end_hour,
          timezone: values.timezone,
          enabled: values.enabled,
          on_demand: values.on_demand,
          issue_intake: values.issue_intake,
          last_run_at: values.last_run_at,
          next_run_at: values.next_run_at,
        },
      })
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .delete(pipelineSchedules)
      .where(and(eq(pipelineSchedules.workspace_id, workspaceId), eq(pipelineSchedules.id, id)))
  }

  async insertRun(workspaceId: string, run: ScheduleRun): Promise<void> {
    await this.db.insert(pipelineScheduleRuns).values({
      workspace_id: workspaceId,
      id: run.id,
      schedule_id: run.scheduleId,
      execution_id: run.executionId,
      status: run.status,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      outcome: run.outcome,
    })
  }

  async updateRun(
    workspaceId: string,
    runId: string,
    patch: Partial<Pick<ScheduleRun, 'status' | 'finishedAt' | 'outcome' | 'executionId'>>,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.status !== undefined) set.status = patch.status
    if (patch.finishedAt !== undefined) set.finished_at = patch.finishedAt
    if (patch.outcome !== undefined) set.outcome = patch.outcome
    if (patch.executionId !== undefined) set.execution_id = patch.executionId
    if (Object.keys(set).length === 0) return
    await this.db
      .update(pipelineScheduleRuns)
      .set(set)
      .where(
        and(eq(pipelineScheduleRuns.workspace_id, workspaceId), eq(pipelineScheduleRuns.id, runId)),
      )
  }

  async listRuns(workspaceId: string, scheduleId: string): Promise<ScheduleRun[]> {
    const rows = await this.db
      .select()
      .from(pipelineScheduleRuns)
      .where(
        and(
          eq(pipelineScheduleRuns.workspace_id, workspaceId),
          eq(pipelineScheduleRuns.schedule_id, scheduleId),
        ),
      )
      .orderBy(desc(pipelineScheduleRuns.started_at))
    return rows.map(rowToRun)
  }

  async pruneRunsBefore(before: number): Promise<number> {
    const rows = await this.db
      .delete(pipelineScheduleRuns)
      .where(lt(pipelineScheduleRuns.started_at, before))
      .returning({ id: pipelineScheduleRuns.id })
    return rows.length
  }
}
