import type { ConfluenceConnectionRecord, ConfluenceConnectionRepository } from '@cat-factory/core'
import type { D1Database } from '@cloudflare/workers-types'

interface ConfluenceConnectionRow {
  workspace_id: string
  base_url: string
  account_email: string
  api_token: string
  created_at: number
  deleted_at: number | null
}

function rowToRecord(row: ConfluenceConnectionRow): ConfluenceConnectionRecord {
  return {
    workspaceId: row.workspace_id,
    baseUrl: row.base_url,
    accountEmail: row.account_email,
    apiToken: row.api_token,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  }
}

/** D1-backed store of workspace → Confluence site connections (migration 0005). */
export class D1ConfluenceConnectionRepository implements ConfluenceConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(workspaceId: string): Promise<ConfluenceConnectionRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM confluence_connections WHERE workspace_id = ? AND deleted_at IS NULL')
      .bind(workspaceId)
      .first<ConfluenceConnectionRow>()
    return row ? rowToRecord(row) : null
  }

  async upsert(record: ConfluenceConnectionRecord): Promise<void> {
    // A workspace has a single live connection: clear any prior binding (live or
    // tombstoned) before inserting, so reconnecting to a different account can't
    // collide on the (workspace_id, account_email) primary key.
    await this.db
      .prepare('DELETE FROM confluence_connections WHERE workspace_id = ?')
      .bind(record.workspaceId)
      .run()
    await this.db
      .prepare(
        `INSERT INTO confluence_connections
          (workspace_id, base_url, account_email, api_token, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.baseUrl,
        record.accountEmail,
        record.apiToken,
        record.createdAt,
      )
      .run()
  }

  async softDelete(workspaceId: string, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE confluence_connections SET deleted_at = ? WHERE workspace_id = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId)
      .run()
  }
}
