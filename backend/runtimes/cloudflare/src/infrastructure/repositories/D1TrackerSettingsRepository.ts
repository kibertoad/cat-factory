import type { TrackerSettings, TrackerSettingsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TrackerRow {
  tracker: string | null
  jira_project_key: string | null
  updated_at: number
}

/** A workspace's issue-tracker selection, one row per workspace (migration 0029). */
export class D1TrackerSettingsRepository implements TrackerSettingsRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<TrackerSettings | null> {
    const row = await this.db
      .prepare(`SELECT * FROM tracker_settings WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<TrackerRow>()
    if (!row) return null
    return {
      tracker: (row.tracker as TrackerSettings['tracker']) ?? null,
      jiraProjectKey: row.jira_project_key,
      updatedAt: row.updated_at,
    }
  }

  async put(workspaceId: string, settings: TrackerSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tracker_settings (workspace_id, tracker, jira_project_key, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           tracker = excluded.tracker,
           jira_project_key = excluded.jira_project_key,
           updated_at = excluded.updated_at`,
      )
      .bind(workspaceId, settings.tracker, settings.jiraProjectKey, settings.updatedAt)
      .run()
  }
}
