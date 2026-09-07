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
import { and, asc, desc, eq, lt } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { environmentTestRuns } from '../db/schema.js'

// Drizzle/Postgres mirror of the D1EnvironmentTestRunRepository. Ephemeral-environment
// self-test runs live in their own `environment_test_runs` table (not agent_runs) because
// they carry a `stage` state machine and are not container agents. Behaviourally identical
// so the cross-runtime conformance suite asserts the same lifecycle on both stores.

function rowToRecord(row: typeof environmentTestRuns.$inferSelect): EnvironmentTestRunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    blockId: row.block_id,
    mode: row.mode as EnvironmentTestMode,
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
    probeDispatchedAt: row.probe_dispatched_at,
    probeProgress: row.probe_progress ? (JSON.parse(row.probe_progress) as StepSubtasks) : null,
    probe: row.probe ? (JSON.parse(row.probe) as EnvironmentProbeReport) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Postgres-backed ephemeral-environment self-test runs. */
export class DrizzleEnvironmentTestRunRepository implements EnvironmentTestRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async insert(record: EnvironmentTestRunRecord): Promise<void> {
    await this.db.insert(environmentTestRuns).values({
      id: record.id,
      workspace_id: record.workspaceId,
      block_id: record.blockId,
      mode: record.mode,
      status: record.status,
      stage: record.stage,
      initiated_by: record.initiatedBy,
      provisioning: JSON.stringify(record.provisioning),
      branch: record.branch,
      environment_id: record.environmentId,
      env_url: record.envUrl,
      error: record.error,
      failed_stage: record.failedStage,
      probe_surface: record.probeSurface,
      probe_dispatched_at: record.probeDispatchedAt,
      probe_progress: record.probeProgress ? JSON.stringify(record.probeProgress) : null,
      probe: record.probe ? JSON.stringify(record.probe) : null,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    })
  }

  async updateIfRunning(
    workspaceId: string,
    id: string,
    patch: EnvironmentTestRunRecordPatch,
  ): Promise<boolean> {
    const set: Record<string, unknown> = {}
    if (patch.status !== undefined) set.status = patch.status
    if (patch.stage !== undefined) set.stage = patch.stage
    if (patch.branch !== undefined) set.branch = patch.branch
    if (patch.environmentId !== undefined) set.environment_id = patch.environmentId
    if (patch.envUrl !== undefined) set.env_url = patch.envUrl
    if (patch.error !== undefined) set.error = patch.error
    if (patch.failedStage !== undefined) set.failed_stage = patch.failedStage
    if (patch.probeSurface !== undefined) set.probe_surface = patch.probeSurface
    if (patch.probeDispatchedAt !== undefined) set.probe_dispatched_at = patch.probeDispatchedAt
    // The structured members of the patch, so the ones that are serialized here.
    if (patch.probeProgress !== undefined) {
      set.probe_progress = patch.probeProgress ? JSON.stringify(patch.probeProgress) : null
    }
    if (patch.probe !== undefined) set.probe = patch.probe ? JSON.stringify(patch.probe) : null
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt
    if (Object.keys(set).length === 0) return false
    const result = await this.db
      .update(environmentTestRuns)
      .set(set)
      .where(
        and(
          eq(environmentTestRuns.workspace_id, workspaceId),
          eq(environmentTestRuns.id, id),
          eq(environmentTestRuns.status, 'running'),
        ),
      )
    return (result.rowCount ?? 0) > 0
  }

  async get(workspaceId: string, id: string): Promise<EnvironmentTestRunRecord | null> {
    const rows = await this.db
      .select()
      .from(environmentTestRuns)
      .where(and(eq(environmentTestRuns.workspace_id, workspaceId), eq(environmentTestRuns.id, id)))
      .limit(1)
    return rows[0] ? rowToRecord(rows[0]) : null
  }

  async listRunningByWorkspace(workspaceId: string): Promise<EnvironmentTestRunRecord[]> {
    const rows = await this.db
      .select()
      .from(environmentTestRuns)
      .where(
        and(
          eq(environmentTestRuns.workspace_id, workspaceId),
          eq(environmentTestRuns.status, 'running'),
        ),
      )
      .orderBy(desc(environmentTestRuns.created_at))
    return rows.map(rowToRecord)
  }

  async listStale(cutoffMs: number, limit = 50): Promise<EnvironmentTestRunRecord[]> {
    const rows = await this.db
      .select()
      .from(environmentTestRuns)
      .where(
        and(
          eq(environmentTestRuns.status, 'running'),
          lt(environmentTestRuns.updated_at, cutoffMs),
        ),
      )
      .orderBy(asc(environmentTestRuns.updated_at))
      .limit(limit)
    return rows.map(rowToRecord)
  }
}
