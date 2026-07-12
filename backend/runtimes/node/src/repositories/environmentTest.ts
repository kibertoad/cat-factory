import type {
  EnvironmentTestRunRecord,
  EnvironmentTestRunRecordPatch,
  EnvironmentTestRunRepository,
  EnvironmentTestStage,
  EnvironmentTestStatus,
} from '@cat-factory/kernel'
import { and, desc, eq } from 'drizzle-orm'
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
    status: row.status as EnvironmentTestStatus,
    stage: row.stage as EnvironmentTestStage,
    initiatedBy: row.initiated_by,
    branch: row.branch,
    environmentId: row.environment_id,
    envUrl: row.env_url,
    error: row.error,
    failedStage: (row.failed_stage as EnvironmentTestStage | null) ?? null,
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
      status: record.status,
      stage: record.stage,
      initiated_by: record.initiatedBy,
      branch: record.branch,
      environment_id: record.environmentId,
      env_url: record.envUrl,
      error: record.error,
      failed_stage: record.failedStage,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    })
  }

  async update(
    workspaceId: string,
    id: string,
    patch: EnvironmentTestRunRecordPatch,
  ): Promise<void> {
    const set: Record<string, unknown> = {}
    if (patch.status !== undefined) set.status = patch.status
    if (patch.stage !== undefined) set.stage = patch.stage
    if (patch.branch !== undefined) set.branch = patch.branch
    if (patch.environmentId !== undefined) set.environment_id = patch.environmentId
    if (patch.envUrl !== undefined) set.env_url = patch.envUrl
    if (patch.error !== undefined) set.error = patch.error
    if (patch.failedStage !== undefined) set.failed_stage = patch.failedStage
    if (patch.updatedAt !== undefined) set.updated_at = patch.updatedAt
    if (Object.keys(set).length === 0) return
    await this.db
      .update(environmentTestRuns)
      .set(set)
      .where(and(eq(environmentTestRuns.workspace_id, workspaceId), eq(environmentTestRuns.id, id)))
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
}
