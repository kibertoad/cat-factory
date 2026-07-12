import type {
  EnvironmentTestRunRecord,
  EnvironmentTestRunRecordPatch,
  EnvironmentTestRunRepository,
  EnvironmentTestStage,
  EnvironmentTestStatus,
  ServiceProvisioning,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface EnvironmentTestRunRow {
  id: string
  workspace_id: string
  block_id: string
  status: string
  stage: string
  initiated_by: string | null
  provisioning: string
  branch: string | null
  environment_id: string | null
  env_url: string | null
  error: string | null
  failed_stage: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: EnvironmentTestRunRow): EnvironmentTestRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    status: row.status as EnvironmentTestStatus,
    stage: row.stage as EnvironmentTestStage,
    initiatedBy: row.initiated_by,
    provisioning: JSON.parse(row.provisioning) as ServiceProvisioning,
    branch: row.branch,
    environmentId: row.environment_id,
    envUrl: row.env_url,
    error: row.error,
    failedStage: (row.failed_stage as EnvironmentTestStage | null) ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** A patch field name → its DB column. */
const PATCH_COLUMNS: Record<keyof EnvironmentTestRunRecordPatch, string> = {
  status: 'status',
  stage: 'stage',
  branch: 'branch',
  environmentId: 'environment_id',
  envUrl: 'env_url',
  error: 'error',
  failedStage: 'failed_stage',
  updatedAt: 'updated_at',
}

/** D1-backed ephemeral-environment self-test runs (migration 0050). */
export class D1EnvironmentTestRunRepository implements EnvironmentTestRunRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: EnvironmentTestRunRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO environment_test_runs
          (id, workspace_id, block_id, status, stage, initiated_by, provisioning, branch,
           environment_id, env_url, error, failed_stage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.blockId,
        record.status,
        record.stage,
        record.initiatedBy,
        JSON.stringify(record.provisioning),
        record.branch,
        record.environmentId,
        record.envUrl,
        record.error,
        record.failedStage,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async updateIfRunning(
    workspaceId: string,
    id: string,
    patch: EnvironmentTestRunRecordPatch,
  ): Promise<boolean> {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined)
    if (entries.length === 0) return false
    const setClause = entries
      .map(([key]) => `${PATCH_COLUMNS[key as keyof EnvironmentTestRunRecordPatch]} = ?`)
      .join(', ')
    const values = entries.map(([, value]) => value as string | number | null)
    const { meta } = await this.db
      .prepare(
        `UPDATE environment_test_runs SET ${setClause}
         WHERE workspace_id = ? AND id = ? AND status = 'running'`,
      )
      .bind(...values, workspaceId, id)
      .run()
    return (meta.changes ?? 0) > 0
  }

  async get(workspaceId: string, id: string): Promise<EnvironmentTestRunRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM environment_test_runs WHERE workspace_id = ? AND id = ?')
      .bind(workspaceId, id)
      .first<EnvironmentTestRunRow>()
    return row ? rowToRecord(row) : null
  }

  async listRunningByWorkspace(workspaceId: string): Promise<EnvironmentTestRunRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM environment_test_runs
         WHERE workspace_id = ? AND status = 'running' ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<EnvironmentTestRunRow>()
    return (results ?? []).map(rowToRecord)
  }

  async listStale(cutoffMs: number, limit = 50): Promise<EnvironmentTestRunRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM environment_test_runs
         WHERE status = 'running' AND updated_at < ? ORDER BY updated_at ASC LIMIT ?`,
      )
      .bind(cutoffMs, limit)
      .all<EnvironmentTestRunRow>()
    return (results ?? []).map(rowToRecord)
  }
}
