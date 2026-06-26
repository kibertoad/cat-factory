import type { KaizenGradingRepository } from '@cat-factory/kernel'
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
    await this.db
      .prepare(
        `INSERT INTO kaizen_gradings
           (workspace_id, id, execution_id, block_id, step_index, agent_kind, model,
            prompt_version, combo_key, status, grade, summary, recommendations, grader_model,
            error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
}
