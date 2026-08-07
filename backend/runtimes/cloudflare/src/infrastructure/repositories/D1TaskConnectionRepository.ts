import type {
  SealedTaskConnectionRecord,
  TaskConnectionRepository,
  TaskSourceKind,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TaskConnectionRow {
  workspace_id: string
  source: string
  credentials: string
  label: string
  created_at: number
  deleted_at: number | null
}

/**
 * D1-backed store of workspace → task-source connections (migration 0014).
 *
 * Source credentials (e.g. a Jira API token) cross this repository as the AES-256-GCM ENVELOPE
 * they are stored as; opening one belongs to `createTaskConnectionStore`
 * (`@cat-factory/integrations`). Same shape, and the same reason, as its document-source sibling.
 */
export class D1TaskConnectionRepository implements TaskConnectionRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  private rowToRecord(row: TaskConnectionRow): SealedTaskConnectionRecord {
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      credentialsCipher: row.credentials,
      label: row.label,
      createdAt: row.created_at,
      deletedAt: row.deleted_at,
    }
  }

  async getByWorkspace(
    workspaceId: string,
    source: TaskSourceKind,
  ): Promise<SealedTaskConnectionRecord | null> {
    const row = await this.db
      .prepare(
        'SELECT * FROM task_connections WHERE workspace_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(workspaceId, source)
      .first<TaskConnectionRow>()
    return row ? this.rowToRecord(row) : null
  }

  async listByWorkspace(workspaceId: string): Promise<SealedTaskConnectionRecord[]> {
    const { results } = await this.db
      .prepare(
        'SELECT * FROM task_connections WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC',
      )
      .bind(workspaceId)
      .all<TaskConnectionRow>()
    return results.map((row) => this.rowToRecord(row))
  }

  async upsert(record: SealedTaskConnectionRecord): Promise<void> {
    // A workspace has a single live connection per source: clear any prior
    // binding (live or tombstoned) before inserting, so reconnecting can't
    // collide on the (workspace_id, source) primary key.
    await this.db
      .prepare('DELETE FROM task_connections WHERE workspace_id = ? AND source = ?')
      .bind(record.workspaceId, record.source)
      .run()
    await this.db
      .prepare(
        `INSERT INTO task_connections
          (workspace_id, source, credentials, label, created_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .bind(
        record.workspaceId,
        record.source,
        record.credentialsCipher,
        record.label,
        record.createdAt,
      )
      .run()
  }

  async softDelete(workspaceId: string, source: TaskSourceKind, at: number): Promise<void> {
    await this.db
      .prepare(
        'UPDATE task_connections SET deleted_at = ? WHERE workspace_id = ? AND source = ? AND deleted_at IS NULL',
      )
      .bind(at, workspaceId, source)
      .run()
  }
}
