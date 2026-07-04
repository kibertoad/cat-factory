import type {
  DueSchedule,
  PipelineScheduleRepository,
  PipelineSchedule,
  Recurrence,
  ScheduleRun,
  ScheduleTemplate,
} from '@cat-factory/kernel'
import { parseIssueIntakeColumn, serializeIssueIntakeColumn } from '@cat-factory/server'
import type { D1Database } from '@cloudflare/workers-types'
import { chunkForIn } from './chunk'

interface ScheduleRow {
  workspace_id: string
  id: string
  service_id: string | null
  block_id: string
  frame_id: string
  pipeline_id: string
  template: string
  name: string
  interval_hours: number
  weekdays: string
  window_start_hour: number | null
  window_end_hour: number | null
  timezone: string
  enabled: number
  on_demand: number
  /** Nullable JSON issue-intake config (migration 0038). */
  issue_intake: string | null
  last_run_at: number | null
  next_run_at: number
  created_at: number
}

interface RunRow {
  id: string
  schedule_id: string
  execution_id: string | null
  status: string
  started_at: number
  finished_at: number | null
  outcome: string | null
}

function rowToSchedule(row: ScheduleRow): PipelineSchedule {
  const recurrence: Recurrence = {
    intervalHours: row.interval_hours,
    weekdays: safeJsonArray(row.weekdays),
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

function safeJsonArray(value: string): number[] {
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

/**
 * Recurring pipelines, in `pipeline_schedules` + `pipeline_schedule_runs`
 * (migration 0029). `listDue` is a deliberately cross-workspace query (the cron
 * sweeper fires every workspace's due schedules in one pass).
 */
export class D1PipelineScheduleRepository implements PipelineScheduleRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<PipelineSchedule | null> {
    const row = await this.db
      .prepare(`SELECT * FROM pipeline_schedules WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<ScheduleRow>()
    return row ? rowToSchedule(row) : null
  }

  async getByBlock(workspaceId: string, blockId: string): Promise<PipelineSchedule | null> {
    const row = await this.db
      .prepare(`SELECT * FROM pipeline_schedules WHERE workspace_id = ? AND block_id = ?`)
      .bind(workspaceId, blockId)
      .first<ScheduleRow>()
    return row ? rowToSchedule(row) : null
  }

  async list(workspaceId: string): Promise<PipelineSchedule[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pipeline_schedules WHERE workspace_id = ? ORDER BY created_at ASC`)
      .bind(workspaceId)
      .all<ScheduleRow>()
    return results.map(rowToSchedule)
  }

  async listByService(serviceId: string): Promise<PipelineSchedule[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM pipeline_schedules WHERE service_id = ? ORDER BY created_at ASC`)
      .bind(serviceId)
      .all<ScheduleRow>()
    return results.map(rowToSchedule)
  }

  async listByServices(serviceIds: string[]): Promise<PipelineSchedule[]> {
    if (serviceIds.length === 0) return []
    const out: PipelineSchedule[] = []
    // Chunk the IN list to stay under D1's bound-parameter limit.
    for (const chunk of chunkForIn(serviceIds)) {
      const placeholders = chunk.map(() => '?').join(', ')
      const { results } = await this.db
        .prepare(
          `SELECT * FROM pipeline_schedules WHERE service_id IN (${placeholders}) ORDER BY created_at ASC`,
        )
        .bind(...chunk)
        .all<ScheduleRow>()
      for (const row of results) out.push(rowToSchedule(row))
    }
    return out
  }

  async listDue(asOf: number): Promise<DueSchedule[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM pipeline_schedules
           WHERE enabled = 1 AND on_demand = 0 AND next_run_at <= ?
           ORDER BY next_run_at ASC`,
      )
      .bind(asOf)
      .all<ScheduleRow>()
    return results.map((row) => ({ workspaceId: row.workspace_id, schedule: rowToSchedule(row) }))
  }

  async upsert(workspaceId: string, schedule: PipelineSchedule): Promise<void> {
    const r = schedule.recurrence
    await this.db
      .prepare(
        `INSERT INTO pipeline_schedules
           (workspace_id, id, service_id, block_id, frame_id, pipeline_id, template, name,
            interval_hours, weekdays, window_start_hour, window_end_hour, timezone, enabled,
            on_demand, issue_intake, last_run_at, next_run_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           service_id = excluded.service_id,
           block_id = excluded.block_id,
           frame_id = excluded.frame_id,
           pipeline_id = excluded.pipeline_id,
           template = excluded.template,
           name = excluded.name,
           interval_hours = excluded.interval_hours,
           weekdays = excluded.weekdays,
           window_start_hour = excluded.window_start_hour,
           window_end_hour = excluded.window_end_hour,
           timezone = excluded.timezone,
           enabled = excluded.enabled,
           on_demand = excluded.on_demand,
           issue_intake = excluded.issue_intake,
           last_run_at = excluded.last_run_at,
           next_run_at = excluded.next_run_at`,
      )
      .bind(
        workspaceId,
        schedule.id,
        schedule.serviceId,
        schedule.blockId,
        schedule.frameId,
        schedule.pipelineId,
        schedule.template,
        schedule.name,
        r.intervalHours,
        JSON.stringify(r.weekdays),
        r.windowStartHour,
        r.windowEndHour,
        r.timezone,
        schedule.enabled ? 1 : 0,
        schedule.onDemand ? 1 : 0,
        serializeIssueIntakeColumn(schedule.issueIntake),
        schedule.lastRunAt,
        schedule.nextRunAt,
        schedule.createdAt,
      )
      .run()
  }

  async remove(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM pipeline_schedules WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }

  async insertRun(workspaceId: string, run: ScheduleRun): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pipeline_schedule_runs
           (workspace_id, id, schedule_id, execution_id, status, started_at, finished_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        workspaceId,
        run.id,
        run.scheduleId,
        run.executionId,
        run.status,
        run.startedAt,
        run.finishedAt,
        run.outcome,
      )
      .run()
  }

  async updateRun(
    workspaceId: string,
    runId: string,
    patch: Partial<Pick<ScheduleRun, 'status' | 'finishedAt' | 'outcome' | 'executionId'>>,
  ): Promise<void> {
    const sets: string[] = []
    const binds: (string | number | null)[] = []
    if (patch.status !== undefined) {
      sets.push('status = ?')
      binds.push(patch.status)
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?')
      binds.push(patch.finishedAt)
    }
    if (patch.outcome !== undefined) {
      sets.push('outcome = ?')
      binds.push(patch.outcome)
    }
    if (patch.executionId !== undefined) {
      sets.push('execution_id = ?')
      binds.push(patch.executionId)
    }
    if (sets.length === 0) return
    binds.push(workspaceId, runId)
    await this.db
      .prepare(
        `UPDATE pipeline_schedule_runs SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
      )
      .bind(...binds)
      .run()
  }

  async listRuns(workspaceId: string, scheduleId: string): Promise<ScheduleRun[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM pipeline_schedule_runs
           WHERE workspace_id = ? AND schedule_id = ?
           ORDER BY started_at DESC`,
      )
      .bind(workspaceId, scheduleId)
      .all<RunRow>()
    return results.map(rowToRun)
  }

  async pruneRunsBefore(before: number): Promise<number> {
    const res = await this.db
      .prepare(`DELETE FROM pipeline_schedule_runs WHERE started_at < ?`)
      .bind(before)
      .run()
    return res.meta.changes ?? 0
  }
}
