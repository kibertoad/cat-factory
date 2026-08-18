import type { KaizenGradingRepository } from '@cat-factory/kernel'
import { KAIZEN_SETTLED_STATUSES } from '@cat-factory/contracts'
import type { KaizenGrading, KaizenGradingStatus } from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface KaizenGradingRow {
  workspace_id: string
  id: string
  execution_id: string
  block_id: string
  step_index: number
  agent_kind: string
  model: string
  prompt_version: number
  combo_key: string
  status: string
  grade: number | null
  summary: string
  recommendations: string
  grader_model: string | null
  error: string | null
  acknowledged_at: number | null
  acknowledged_by: string | null
  acknowledgement_note: string | null
  created_at: number
  updated_at: number
}

function parseStringArray(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function rowToGrading(row: KaizenGradingRow): KaizenGrading {
  return {
    id: row.id,
    executionId: row.execution_id,
    blockId: row.block_id,
    stepIndex: row.step_index,
    agentKind: row.agent_kind,
    model: row.model,
    promptVersion: row.prompt_version,
    comboKey: row.combo_key,
    status: row.status as KaizenGradingStatus,
    grade: row.grade,
    summary: row.summary,
    recommendations: parseStringArray(row.recommendations),
    graderModel: row.grader_model,
    error: row.error,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
    acknowledgementNote: row.acknowledgement_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Kaizen gradings, one row per `(run, step)` in `kaizen_gradings` (migration 0015).
 * Recommendations are a JSON array column. The unique `(execution_id, step_index)` index
 * keeps scheduling idempotent across durable re-drives.
 */
export class D1KaizenGradingRepository implements KaizenGradingRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async upsert(workspaceId: string, grading: KaizenGrading): Promise<void> {
    // The acknowledgement columns are set on INSERT and deliberately absent from the conflict SET
    // list: the sweep re-writes this row on every grader transition, and folding them in would
    // erase a triage the moment a grading was re-run. `setAcknowledgement` is their only writer.
    await this.db
      .prepare(
        `INSERT INTO kaizen_gradings
           (workspace_id, id, execution_id, block_id, step_index, agent_kind, model,
            prompt_version, combo_key, status, grade, summary, recommendations, grader_model,
            error, acknowledged_at, acknowledged_by, acknowledgement_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           status = excluded.status,
           grade = excluded.grade,
           summary = excluded.summary,
           recommendations = excluded.recommendations,
           grader_model = excluded.grader_model,
           error = excluded.error,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        grading.id,
        grading.executionId,
        grading.blockId,
        grading.stepIndex,
        grading.agentKind,
        grading.model,
        grading.promptVersion,
        grading.comboKey,
        grading.status,
        grading.grade,
        grading.summary,
        JSON.stringify(grading.recommendations),
        grading.graderModel,
        grading.error,
        grading.acknowledgedAt,
        grading.acknowledgedBy,
        grading.acknowledgementNote,
        grading.createdAt,
        grading.updatedAt,
      )
      .run()
  }

  async get(workspaceId: string, id: string): Promise<KaizenGrading | null> {
    const row = await this.db
      .prepare(`SELECT * FROM kaizen_gradings WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<KaizenGradingRow>()
    return row ? rowToGrading(row) : null
  }

  async getByStep(
    workspaceId: string,
    executionId: string,
    stepIndex: number,
  ): Promise<KaizenGrading | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM kaizen_gradings
           WHERE workspace_id = ? AND execution_id = ? AND step_index = ?`,
      )
      .bind(workspaceId, executionId, stepIndex)
      .first<KaizenGradingRow>()
    return row ? rowToGrading(row) : null
  }

  async listByExecution(workspaceId: string, executionId: string): Promise<KaizenGrading[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM kaizen_gradings
           WHERE workspace_id = ? AND execution_id = ?
           ORDER BY step_index ASC`,
      )
      .bind(workspaceId, executionId)
      .all<KaizenGradingRow>()
    return (results ?? []).map(rowToGrading)
  }

  async listByWorkspace(workspaceId: string, limit = 200): Promise<KaizenGrading[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM kaizen_gradings
           WHERE workspace_id = ?
           ORDER BY created_at DESC LIMIT ?`,
      )
      .bind(workspaceId, limit)
      .all<KaizenGradingRow>()
    return (results ?? []).map(rowToGrading)
  }

  async listPage(
    workspaceId: string,
    opts: {
      limit: number
      cursor?: { createdAt: number; id: string }
      acknowledged?: boolean
      settled?: boolean
      status?: KaizenGradingStatus
      agentKind?: string
      since?: number
    },
  ): Promise<KaizenGrading[]> {
    const where = ['workspace_id = ?']
    const binds: (string | number)[] = [workspaceId]
    if (opts.cursor) {
      // The keyset is the composite the ORDER BY uses, so gradings sharing a millisecond (every
      // step of one run is scheduled at once) page without losing the ties.
      where.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id)
    }
    if (opts.acknowledged !== undefined) {
      where.push(opts.acknowledged ? 'acknowledged_at IS NOT NULL' : 'acknowledged_at IS NULL')
    }
    if (opts.settled !== undefined) {
      // The same set the acknowledge write is gated on, from the same constant, so the backlog a
      // caller drains and the rows that write accepts cannot drift apart.
      const settled = KAIZEN_SETTLED_STATUSES.map(() => '?').join(', ')
      where.push(`status ${opts.settled ? 'IN' : 'NOT IN'} (${settled})`)
      binds.push(...KAIZEN_SETTLED_STATUSES)
    }
    if (opts.status) {
      where.push('status = ?')
      binds.push(opts.status)
    }
    if (opts.agentKind) {
      where.push('agent_kind = ?')
      binds.push(opts.agentKind)
    }
    if (opts.since !== undefined) {
      where.push('created_at >= ?')
      binds.push(opts.since)
    }
    binds.push(opts.limit)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM kaizen_gradings
           WHERE ${where.join(' AND ')}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<KaizenGradingRow>()
    return (results ?? []).map(rowToGrading)
  }

  async setAcknowledgement(
    workspaceId: string,
    id: string,
    ack: { by: string | null; note: string | null } | null,
    now: number,
  ): Promise<KaizenGrading | null> {
    if (ack) {
      // Guarded in the statement rather than by a pre-check: `acknowledged_at IS NULL` makes a
      // repeat acknowledgement a no-op (so the stamp keeps naming the FIRST triage), and the status
      // list refuses a row the grader is still working on, with no window between check and write.
      // `updated_at` moves with it, so a consumer watermarking on it sees triage state change.
      const settled = KAIZEN_SETTLED_STATUSES.map(() => '?').join(', ')
      await this.db
        .prepare(
          `UPDATE kaizen_gradings
             SET acknowledged_at = ?, acknowledged_by = ?, acknowledgement_note = ?, updated_at = ?
             WHERE workspace_id = ? AND id = ? AND acknowledged_at IS NULL
               AND status IN (${settled})`,
        )
        .bind(now, ack.by, ack.note, now, workspaceId, id, ...KAIZEN_SETTLED_STATUSES)
        .run()
    } else {
      // Guarded on there being an acknowledgement to clear, so clearing one that was never
      // recorded writes nothing at all rather than touching `updated_at` on a row (a `running`
      // grading, say) whose staleness stamp the sweep reads to decide what to re-drive.
      await this.db
        .prepare(
          `UPDATE kaizen_gradings
             SET acknowledged_at = NULL, acknowledged_by = NULL, acknowledgement_note = NULL,
                 updated_at = ?
             WHERE workspace_id = ? AND id = ? AND acknowledged_at IS NOT NULL`,
        )
        .bind(now, workspaceId, id)
        .run()
    }
    return this.get(workspaceId, id)
  }

  async listPending(
    staleBefore: number,
    limit: number,
  ): Promise<{ workspaceId: string; grading: KaizenGrading }[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM kaizen_gradings
           WHERE status = 'scheduled' OR (status = 'running' AND updated_at < ?)
           ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(staleBefore, limit)
      .all<KaizenGradingRow>()
    return (results ?? []).map((row) => ({
      workspaceId: row.workspace_id,
      grading: rowToGrading(row),
    }))
  }

  async claim(workspaceId: string, id: string, staleBefore: number, now: number): Promise<boolean> {
    // Conditional flip to `running`: succeeds only if the row is still claimable (the same
    // predicate listPending selects on), so concurrent sweep passes can't both win it.
    const { meta } = await this.db
      .prepare(
        `UPDATE kaizen_gradings SET status = 'running', updated_at = ?
           WHERE workspace_id = ? AND id = ?
             AND (status = 'scheduled' OR (status = 'running' AND updated_at < ?))`,
      )
      .bind(now, workspaceId, id, staleBefore)
      .run()
    return (meta.changes ?? 0) > 0
  }
}
