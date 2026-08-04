import type { NotificationWebhookRecord, NotificationWebhookRepository } from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import {
  parseNotificationWebhookTypes,
  parsePlatformAlertEvents,
  parseRunLifecycleEvents,
} from '@cat-factory/server'

interface NotificationWebhookRow {
  workspace_id: string
  url: string
  types: string
  run_events: string
  alert_events: string
  enabled: number
  secret_sealed: string | null
  updated_at: number
}

/**
 * A workspace's outbound webhook, one row per workspace (migration 0061; `run_events` added in
 * 0072, `alert_events` in 0080). All three JSON filter columns are decoded through the SHARED
 * parsers the Drizzle repo uses, so the columns can't drift between runtimes.
 */
export class D1NotificationWebhookRepository implements NotificationWebhookRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string): Promise<NotificationWebhookRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM notification_webhooks WHERE workspace_id = ?`)
      .bind(workspaceId)
      .first<NotificationWebhookRow>()
    if (!row) return null
    return {
      workspaceId: row.workspace_id,
      url: row.url,
      types: parseNotificationWebhookTypes(row.types),
      runEvents: parseRunLifecycleEvents(row.run_events),
      alertEvents: parsePlatformAlertEvents(row.alert_events),
      enabled: row.enabled === 1,
      secretSealed: row.secret_sealed,
      updatedAt: row.updated_at,
    }
  }

  async put(record: NotificationWebhookRecord): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notification_webhooks
           (workspace_id, url, types, run_events, alert_events, enabled, secret_sealed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id) DO UPDATE SET
           url = excluded.url,
           types = excluded.types,
           run_events = excluded.run_events,
           alert_events = excluded.alert_events,
           enabled = excluded.enabled,
           secret_sealed = excluded.secret_sealed,
           updated_at = excluded.updated_at`,
      )
      .bind(
        record.workspaceId,
        record.url,
        JSON.stringify(record.types),
        JSON.stringify(record.runEvents),
        JSON.stringify(record.alertEvents),
        record.enabled ? 1 : 0,
        record.secretSealed,
        record.updatedAt,
      )
      .run()
  }

  async delete(workspaceId: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM notification_webhooks WHERE workspace_id = ?`)
      .bind(workspaceId)
      .run()
  }
}
