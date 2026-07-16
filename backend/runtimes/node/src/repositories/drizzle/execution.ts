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
  LiveRunSummary,
  Pipeline,
  PipelineRepository,
  PipelineSchedule,
  PipelineScheduleRepository,
  Recurrence,
  RunRef,
  ScheduleRun,
  ScheduleTemplate,
  StaleAgentRun,
} from '@cat-factory/kernel'
import { agentRunKindSchema } from '@cat-factory/contracts'
import type { ExecutionRow } from '@cat-factory/server'
import {
  decodeEnum,
  executionToDetail,
  parseIssueIntakeColumn,
  rowToExecution,
  rowToPipeline,
  serializeIssueIntakeColumn,
  tryDecodeRows,
} from '@cat-factory/server'
import { and, desc, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../../db/client.js'
import {
  agentRuns,
  blocks,
  pipelineScheduleRuns,
  pipelineSchedules,
  pipelines,
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
      .where(
        and(
          eq(agentRuns.workspace_id, workspaceId),
          this.isExecution,
          inArray(agentRuns.status, ['running', 'blocked', 'paused']),
        ),
      )
    return rows.map((r) => ({
      id: r.id,
      blockId: r.blockId ?? '',
      status: r.status as LiveRunSummary['status'],
    }))
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
        created_at: now,
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
          created_at: now,
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
      })
      .from(agentRuns)
      .where(and(eq(agentRuns.status, 'running'), lt(agentRuns.updated_at, olderThanEpochMs)))
      .orderBy(agentRuns.updated_at)
    return rows.map((r) => ({
      workspaceId: r.workspaceId,
      id: r.id,
      updatedAt: r.updatedAt,
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
