import type { DatadogConnectionRecord, DatadogConnectionRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface DatadogConnectionRow {
  workspace_id: string
  site: string
  api_key: string
  app_key: string
  created_at: number
  updated_at: number
}

function rowToRecord(row: DatadogConnectionRow): DatadogConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    site: row.site,
    apiKey: row.api_key,
    appKey: row.app_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * A workspace's Datadog connection (migration 0003). Exactly one row per workspace
 * (the workspace id is the primary key). `api_key`/`app_key` are stored as sealed
 * envelopes — the caller encrypts before upsert and decrypts at call time.
 */
export class D1DatadogConnectionRepository implements DatadogConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<DatadogConnectionRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM datadog_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<DatadogConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: DatadogConnectionRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO datadog_connections (workspace_id, site, api_key, app_key, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           site = excluded.site,
           api_key = excluded.api_key,
           app_key = excluded.app_key,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.site,
        record.apiKey,
        record.appKey,
        record.createdAt,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM datadog_connections WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}
