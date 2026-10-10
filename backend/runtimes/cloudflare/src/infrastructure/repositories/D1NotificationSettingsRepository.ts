import type {
  NotificationSettingsRecord,
  NotificationSettingsRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

// D1-backed store for the notification manager (migration 0088): a workspace's per-type,
// per-channel routing overrides. Behaviourally identical to the Drizzle mirror so the
// cross-runtime conformance suite asserts the same routing on both stores.

interface NotificationSettingsRow {
  workspace_id: string
  matrix: string
  updated_at: number
}

export class D1NotificationSettingsRepository implements NotificationSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async getByWorkspace(workspaceId: string): Promise<NotificationSettingsRecord | null> {
    const row = await this.db
      .prepare('SELECT * FROM notification_settings WHERE workspace_id = ?')
      .bind(workspaceId)
      .first<NotificationSettingsRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      matrixJson: row.matrix,
      updatedAt: row.updated_at,
    }
  }

  async upsert(record: NotificationSettingsRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notification_settings (workspace_id, matrix, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           matrix = excluded.matrix,
           updated_at = excluded.updated_at`,
      )
      .bind(record.workspaceId, record.matrixJson, record.updatedAt)
      .run()
  }
}
