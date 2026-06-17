import type {
  RunnerPoolConnectionRecord,
  RunnerPoolConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface RunnerPoolConnectionRow {
  workspace_id: string
  provider_id: string
  label: string
  base_url: string
  manifest_json: string
  secrets_cipher: string
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: RunnerPoolConnectionRow): RunnerPoolConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    providerId: row.provider_id,
    label: row.label,
    baseUrl: row.base_url,
    manifestJson: row.manifest_json,
    secretsCipher: row.secrets_cipher,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of workspace → runner-pool bindings (migration 0013). */
export class D1RunnerPoolConnectionRepository implements RunnerPoolConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(workspaceId: string): Promise<RunnerPoolConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM runner_pool_connections WHERE workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId)
      .first<RunnerPoolConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: RunnerPoolConnectionRecord): Promise<void> {
    // A workspace has a single live pool: clear any prior binding (live or
    // tombstoned) before inserting, so re-registering a different pool can't
    // collide on the (workspace_id, provider_id) primary key.
    await this.db
      .prepare('DELETE FROM runner_pool_connections WHERE workspace_id = ?')
      .bind(record.workspaceId)
      .run()
    await this.db
      .prepare(
        `INSERT INTO runner_pool_connections
          (workspace_id, provider_id, label, base_url, manifest_json, secrets_cipher, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.providerId,
        record.label,
        record.baseUrl,
        record.manifestJson,
        record.secretsCipher,
        record.createdAt,
      )
      .run()
  }

  async softDelete(workspaceId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE runner_pool_connections SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId)
      .run()
  }
}
