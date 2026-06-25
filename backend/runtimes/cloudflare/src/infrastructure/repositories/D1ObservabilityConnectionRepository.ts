import type {
  ObservabilityConnectionRecord,
  ObservabilityConnectionRepository,
  ObservabilityProviderKind,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface ObservabilityConnectionRow {
  workspace_id: string
  provider: string
  credentials: string
  summary: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: ObservabilityConnectionRow): ObservabilityConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    provider: row.provider as ObservabilityProviderKind,
    credentials: row.credentials,
    summary: row.summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's observability connection (migration 0007). Exactly one row per workspace
 * (the workspace id is the primary key). `credentials` is a sealed envelope of the
 * provider-specific secret JSON — the caller encrypts before upsert and decrypts at call
 * time; `summary` is a non-secret display blob.
 */
export class D1ObservabilityConnectionRepository implements ObservabilityConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<ObservabilityConnectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM observability_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<ObservabilityConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: ObservabilityConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO observability_connections (workspace_id, provider, credentials, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           provider = excluded.provider,
           credentials = excluded.credentials,
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.provider,
        record.credentials,
        record.summary,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM observability_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}
