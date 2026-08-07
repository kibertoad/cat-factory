import type {
  NotificationWebhookPutOutcome,
  NotificationWebhookRecord,
  NotificationWebhookRepository,
} from '@cat-factory/kernel'
import type { D1Database } from '@cloudflare/workers-types'
import {
  parseNotificationWebhookTypes,
  parsePlatformAlertEvents,
  parseRunLifecycleEvents,
} from '@cat-factory/server'

interface NotificationWebhookRow {
  workspace_id: string
  id: string
  name: string
  url: string
  types: string
  run_events: string
  alert_events: string
  enabled: number
  secret_sealed: string | null
  updated_at: number
}

/**
 * A workspace's outbound webhooks, keyed by (workspace, endpoint id) (migration 0061; `run_events`
 * added in 0072, `alert_events` in 0080, the named-collection key in 0085). All three JSON filter
 * columns are decoded through the SHARED parsers the Drizzle repo uses, so the columns can't drift
 * between runtimes.
 */
export class D1NotificationWebhookRepository implements NotificationWebhookRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<NotificationWebhookRecord | null> {
    const row = await this.db
      .prepare(`SELECT * FROM notification_webhooks WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<NotificationWebhookRow>()
    return row ? toRecord(row) : null
  }

  async list(workspaceId: string): Promise<NotificationWebhookRecord[]> {
    // `COLLATE BINARY` is SQLite's default for a text column and is spelled out only to name the
    // order this port promises: the Drizzle mirror has to ask Postgres for `COLLATE "C"` to match,
    // because its database-locale default would sort `web-hook` after `webhook` by ignoring the
    // punctuation. Byte order on both, so the two runtimes return one sequence.
    const { results } = await this.db
      .prepare(
        `SELECT * FROM notification_webhooks WHERE workspace_id = ? ORDER BY id COLLATE BINARY`,
      )
      .bind(workspaceId)
      .all<NotificationWebhookRow>()
    return (results ?? []).map(toRecord)
  }

  async put(
    record: NotificationWebhookRecord,
    limit: number,
  ): Promise<NotificationWebhookPutOutcome> {
    // ONE statement, so the cap and the write cannot be separated by another writer. The row
    // source is a `SELECT ... WHERE` rather than `VALUES` precisely so the admission test rides
    // inside the insert: SQLite serializes statements, so a concurrent enrolment either sees this
    // row or is seen by it, and can never read the same free slot twice.
    //
    // The predicate admits an existing endpoint unconditionally (`EXISTS`) before it consults the
    // count, because the count includes that row: without the first half, a workspace sitting
    // exactly at the limit could no longer edit, disable or re-point what it had already
    // registered, which are the only ways back under it.
    //
    // The `WHERE` also disambiguates the parse. SQLite cannot otherwise tell an upsert's `ON
    // CONFLICT` from a join's `ON` in an `INSERT ... SELECT`, and its documented fix is exactly a
    // `WHERE` clause on the SELECT, which this needs anyway.
    const result = await this.db
      .prepare(
        `INSERT INTO notification_webhooks
           (workspace_id, id, name, url, types, run_events, alert_events, enabled, secret_sealed, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM notification_webhooks WHERE workspace_id = ? AND id = ?)
            OR (SELECT COUNT(*) FROM notification_webhooks WHERE workspace_id = ?) < ?
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           name = excluded.name,
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
        record.id,
        record.name,
        record.url,
        JSON.stringify(record.types),
        JSON.stringify(record.runEvents),
        JSON.stringify(record.alertEvents),
        record.enabled ? 1 : 0,
        record.secretSealed,
        record.updatedAt,
        record.workspaceId,
        record.id,
        record.workspaceId,
        limit,
      )
      .run()
    // A filtered-out row writes nothing, which is the refusal. An admitted one always reports a
    // change, whether it inserted or took the conflict branch.
    return (result.meta?.changes ?? 0) > 0 ? 'stored' : 'limit_reached'
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM notification_webhooks WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .run()
  }
}

function toRecord(row: NotificationWebhookRow): NotificationWebhookRecord {
  return {
    workspaceId: row.workspace_id,
    id: row.id,
    name: row.name,
    url: row.url,
    types: parseNotificationWebhookTypes(row.types),
    runEvents: parseRunLifecycleEvents(row.run_events),
    alertEvents: parsePlatformAlertEvents(row.alert_events),
    enabled: row.enabled === 1,
    secretSealed: row.secret_sealed,
    updatedAt: row.updated_at,
  }
}
