import type {
  EnvironmentConnectionRecord,
  EnvironmentConnectionRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface EnvironmentConnectionRow {
  workspace_id: string
  kind: string | null
  provider_id: string
  label: string
  base_url: string
  manifest_json: string
  secrets_cipher: string
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: EnvironmentConnectionRow): EnvironmentConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    kind: row.kind ?? 'manifest',
    providerId: row.provider_id,
    label: row.label,
    baseUrl: row.base_url,
    manifestJson: row.manifest_json,
    secretsCipher: row.secrets_cipher,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of workspace → environment provider bindings (migration 0008). */
export class D1EnvironmentConnectionRepository implements EnvironmentConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(workspaceId: string): Promise<EnvironmentConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM environment_connections WHERE workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId)
      .first<EnvironmentConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: EnvironmentConnectionRecord): Promise<void> {
    // A workspace has a single live provider: clear any prior binding (live or
    // tombstoned) before inserting, so re-registering a different provider can't
    // collide on the (workspace_id, provider_id) primary key.
    await this.db
      .prepare('DELETE FROM environment_connections WHERE workspace_id = ?')
      .bind(record.workspaceId)
      .run()
    await this.db
      .prepare(
        `INSERT INTO environment_connections
          (workspace_id, kind, provider_id, label, base_url, manifest_json, secrets_cipher, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.kind,
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
        'UPDATE environment_connections SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId)
      .run()
  }
}
