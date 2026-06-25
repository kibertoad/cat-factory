import type {
  TaskSourceKind,
  TaskSourceSettingsRecord,
  TaskSourceSettingsRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TaskSourceSettingsRow {
  workspace_id: string
  source: string
  enabled: number
}

/**
 * D1-backed store of the per-workspace task-source toggle (migration 0008). A
 * row's absence means the default (enabled), so the source is offered as soon as
 * it is available; a row with `enabled = 0` is an explicit opt-out (e.g. a
 * workspace that uses GitHub repos but not their issues as a task source).
 * Mirrors the Node Drizzle `DrizzleTaskSourceSettingsRepository` (parity rule).
 */
export class D1TaskSourceSettingsRepository implements TaskSourceSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  private rowToRecord(row: TaskSourceSettingsRow): TaskSourceSettingsRecord {
    return {
      workspaceId: row.workspace_id,
      source: row.source as TaskSourceKind,
      enabled: row.enabled !== 0,
    }
  }

  async getByWorkspace(workspaceId: string): Promise<TaskSourceSettingsRecord[]> {
    const { results } = await this.db
      .prepare('SELECT * FROM task_source_settings WHERE workspace_id = ?')
      .bind(workspaceId)
      .all<TaskSourceSettingsRow>()
    return results.map((row) => this.rowToRecord(row))
  }

  async get(workspaceId: string, source: TaskSourceKind): Promise<TaskSourceSettingsRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM task_source_settings WHERE workspace_id = ? AND source = ?')
      .bind(workspaceId, source)
      .first<TaskSourceSettingsRow>()
    return row ? this.rowToRecord(row) : null
  }

  async upsert(record: TaskSourceSettingsRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO task_source_settings (workspace_id, source, enabled)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, source) DO UPDATE SET enabled = excluded.enabled`,
      )
      .bind(record.workspaceId, record.source, record.enabled ? 1 : 0)
      .run()
  }
}
