import type {
  EnvironmentProbeReport,
  EnvironmentProbeSurface,
  EnvironmentTestMode,
  EnvironmentTestRunRecord,
  EnvironmentTestRunRecordPatch,
  EnvironmentTestRunRepository,
  EnvironmentTestStage,
  EnvironmentTestStatus,
  ServiceProvisioning,
  StepSubtasks,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface EnvironmentTestRunRow {
  id: string
  workspace_id: string
  block_id: string
  mode: string
  status: string
  stage: string
  initiated_by: string | null
  provisioning: string
  branch: string | null
  environment_id: string | null
  env_url: string | null
  error: string | null
  failed_stage: string | null
  probe_surface: string | null
  probe_dispatched_at: number | null
  probe_model: string | null
  probe_subscription_token_id: string | null
  probe_subscription_vendor: string | null
  probe_progress: string | null
  probe: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: EnvironmentTestRunRow): EnvironmentTestRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    // A row written before the column existed reads as the provisioning self-test it was.
    mode: (row.mode as EnvironmentTestMode | null) ?? 'provision',
    status: row.status as EnvironmentTestStatus,
    stage: row.stage as EnvironmentTestStage,
    initiatedBy: row.initiated_by,
    provisioning: JSON.parse(row.provisioning) as ServiceProvisioning,
    branch: row.branch,
    environmentId: row.environment_id,
    envUrl: row.env_url,
    error: row.error,
    failedStage: (row.failed_stage as EnvironmentTestStage | null) ?? null,
    probeSurface: (row.probe_surface as EnvironmentProbeSurface | null) ?? null,
    probeDispatchedAt: row.probe_dispatched_at ?? null,
    probeModel: row.probe_model ?? null,
    probeSubscriptionTokenId: row.probe_subscription_token_id ?? null,
    probeSubscriptionVendor: row.probe_subscription_vendor ?? null,
    probeProgress: row.probe_progress ? (JSON.parse(row.probe_progress) as StepSubtasks) : null,
    probe: row.probe ? (JSON.parse(row.probe) as EnvironmentProbeReport) : null,
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
  probeSurface: 'probe_surface',
  probeDispatchedAt: 'probe_dispatched_at',
  probeModel: 'probe_model',
  probeSubscriptionTokenId: 'probe_subscription_token_id',
  probeSubscriptionVendor: 'probe_subscription_vendor',
  probeProgress: 'probe_progress',
  probe: 'probe',
  updatedAt: 'updated_at',
}

/** The patch members held as JSON text, so a write serializes exactly these and no others. */
const JSON_PATCH_FIELDS = new Set<string>([
  'probe',
  'probeProgress',
] satisfies (keyof EnvironmentTestRunRecordPatch)[])

/** D1-backed ephemeral-environment self-test runs (migrations 0050 / 0101 / 0102). */
export class D1EnvironmentTestRunRepository implements EnvironmentTestRunRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async insert(record: EnvironmentTestRunRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO environment_test_runs
          (id, workspace_id, block_id, mode, status, stage, initiated_by, provisioning, branch,
           environment_id, env_url, error, failed_stage, probe_surface, probe_dispatched_at,
           probe_model, probe_subscription_token_id, probe_subscription_vendor, probe_progress,
           probe, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.blockId,
        record.mode,
        record.status,
        record.stage,
        record.initiatedBy,
        JSON.stringify(record.provisioning),
        record.branch,
        record.environmentId,
        record.envUrl,
        record.error,
        record.failedStage,
        record.probeSurface,
        record.probeDispatchedAt,
        record.probeModel,
        record.probeSubscriptionTokenId,
        record.probeSubscriptionVendor,
        record.probeProgress ? JSON.stringify(record.probeProgress) : null,
        record.probe ? JSON.stringify(record.probe) : null,
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
    // The structured members of the patch are serialized here; every other one binds as a scalar.
    const values = entries.map(([key, value]) =>
      JSON_PATCH_FIELDS.has(key) && value !== null
        ? JSON.stringify(value)
        : (value as string | number | null),
    )
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
