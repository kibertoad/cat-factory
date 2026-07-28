import type {
  ProvisioningLogQuery,
  ProvisioningLogRecord,
  ProvisioningLogRepository,
  ProvisioningOutcome,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ProvisioningLogRow {
  id: string
  workspace_id: string
  subsystem: string
  operation: string
  target_id: string | null
  provider_id: string | null
  block_id: string | null
  execution_id: string | null
  outcome: string
  error: string | null
  detail: string | null
  created_at: number
}

function rowToRecord(row: ProvisioningLogRow): ProvisioningLogRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    subsystem: row.subsystem as ProvisioningLogRecord['subsystem'],
    operation: row.operation as ProvisioningLogRecord['operation'],
    targetId: row.target_id,
    providerId: row.provider_id,
    blockId: row.block_id,
    executionId: row.execution_id,
    outcome: row.outcome as ProvisioningLogRecord['outcome'],
    error: row.error,
    detail: row.detail,
    createdAt: row.created_at,
  }
}

/**
 * D1-backed provisioning event log. Lives in the SEPARATE `PROVISIONING_DB`
 * binding (its own database + migrations dir) so its high write churn is isolated
 * from the main `DB`. Append-only + a retention prune.
 */
export class D1ProvisioningLogRepository implements ProvisioningLogRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async append(record: ProvisioningLogRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO provisioning_log
           (id, workspace_id, subsystem, operation, target_id, provider_id, block_id,
            execution_id, outcome, error, detail, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        record.workspaceId,
        record.subsystem,
        record.operation,
        record.targetId,
        record.providerId,
        record.blockId,
        record.executionId,
        record.outcome,
        record.error,
        record.detail,
        record.createdAt,
      )
      .run()
  }

  async list(
    workspaceId: string,
    query: ProvisioningLogQuery = {},
  ): Promise<ProvisioningLogRecord[]> {
    const clauses = ['workspace_id = ?']
    const binds: unknown[] = [workspaceId]
    if (query.subsystem) {
      clauses.push('subsystem = ?')
      binds.push(query.subsystem)
    }
    if (query.executionId) {
      clauses.push('execution_id = ?')
      binds.push(query.executionId)
    }
    if (query.targetId) {
      clauses.push('target_id = ?')
      binds.push(query.targetId)
    }
    if (query.cursor) {
      // Composite keyset matching the ORDER BY: provisioning attempts are appended in bursts,
      // so a `created_at`-only bound would silently drop rows sharing a millisecond.
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
      binds.push(query.cursor.createdAt, query.cursor.createdAt, query.cursor.id)
    }
    // Newest first; `LIMIT -1` means "no limit" in SQLite, so an omitted cap reads all.
    binds.push(query.limit ?? -1)
    const { results } = await this.db
      .prepare(
        `SELECT * FROM provisioning_log
         WHERE ${clauses.join(' AND ')}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .bind(...binds)
      .all<ProvisioningLogRow>()
    return (results ?? []).map(rowToRecord)
  }

  async countByExecution(
    workspaceId: string,
    executionId: string,
    outcome?: ProvisioningOutcome,
  ): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM provisioning_log
         WHERE workspace_id = ? AND execution_id = ? AND (? IS NULL OR outcome = ?)`,
      )
      .bind(workspaceId, executionId, outcome ?? null, outcome ?? null)
      .first<{ n: number }>()
    return row?.n ?? 0
  }

  async deleteOlderThan(epochMs: number): Promise<number> {
    const { meta } = await this.db
      .prepare('DELETE FROM provisioning_log WHERE created_at < ?')
      .bind(epochMs)
      .run()
    return meta.changes ?? 0
  }
}
