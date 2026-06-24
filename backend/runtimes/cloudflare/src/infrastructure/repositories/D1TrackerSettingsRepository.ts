import type { TrackerSettings, TrackerSettingsRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'

interface TrackerRow {
  tracker: string | null
  jira_project_key: string | null
  writeback_comment_on_pr_open: number
  writeback_resolve_on_merge: number
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
      writebackCommentOnPrOpen: row.writeback_comment_on_pr_open === 1,
      writebackResolveOnMerge: row.writeback_resolve_on_merge === 1,
      updatedAt: row.updated_at,
    }
  }

  async put(workspaceId: string, settings: TrackerSettings): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO tracker_settings
           (workspace_id, tracker, jira_project_key,
            writeback_comment_on_pr_open, writeback_resolve_on_merge, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           tracker = excluded.tracker,
           jira_project_key = excluded.jira_project_key,
           writeback_comment_on_pr_open = excluded.writeback_comment_on_pr_open,
           writeback_resolve_on_merge = excluded.writeback_resolve_on_merge,
           updated_at = excluded.updated_at`,
      )
      .bind(
        workspaceId,
        settings.tracker,
        settings.jiraProjectKey,
        settings.writebackCommentOnPrOpen ? 1 : 0,
        settings.writebackResolveOnMerge ? 1 : 0,
        settings.updatedAt,
      )
      .run()
  }
}
