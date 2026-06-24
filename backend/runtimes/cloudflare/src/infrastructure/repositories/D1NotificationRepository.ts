import type { NotificationRepository } from '@cat-factory/kernel'
import type {
  Notification,
  NotificationPayload,
  NotificationSeverity,
  NotificationType,
} from '@cat-factory/contracts'
import type { D1Database } from '@cloudflare/workers-types'

interface NotificationRow {
  id: string
  type: string
  status: string
  severity: string | null
  block_id: string | null
  execution_id: string | null
  title: string
  body: string
  payload: string | null
  created_at: number
  resolved_at: number | null
}

function rowToNotification(row: NotificationRow): Notification {
  let payload: NotificationPayload | null = null
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as NotificationPayload
    } catch {
      payload = null
    }
  }
  return {
    id: row.id,
    type: row.type as NotificationType,
    status: row.status as Notification['status'],
    severity: (row.severity as NotificationSeverity | null) ?? 'normal',
    blockId: row.block_id,
    executionId: row.execution_id,
    title: row.title,
    body: row.body,
    payload,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}

/**
 * Notifications, one row per notification in `notifications` (migration 0024).
 * The optional structured `payload` (assessment / PR url / pipeline name) is a
 * JSON column. Open notifications back the board inbox + snapshot; the engine
 * de-dupes an open card per (block, type) via {@link findOpenByBlock}.
 */
export class D1NotificationRepository implements NotificationRepository {
  private readonly db: D1Database

  constructor({ db }: { db: D1Database }) {
    this.db = db
  }

  async get(workspaceId: string, id: string): Promise<Notification | null> {
    const row = await this.db
      .prepare(`SELECT * FROM notifications WHERE workspace_id = ? AND id = ?`)
      .bind(workspaceId, id)
      .first<NotificationRow>()
    return row ? rowToNotification(row) : null
  }

  async listOpen(workspaceId: string): Promise<Notification[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM notifications
           WHERE workspace_id = ? AND status = 'open'
           ORDER BY created_at DESC`,
      )
      .bind(workspaceId)
      .all<NotificationRow>()
    return results.map(rowToNotification)
  }

  async findOpenByBlock(
    workspaceId: string,
    blockId: string,
    type: NotificationType,
  ): Promise<Notification | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM notifications
           WHERE workspace_id = ? AND block_id = ? AND type = ? AND status = 'open'
           ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(workspaceId, blockId, type)
      .first<NotificationRow>()
    return row ? rowToNotification(row) : null
  }

  async upsert(workspaceId: string, notification: Notification): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO notifications
           (workspace_id, id, type, status, severity, block_id, execution_id, title, body, payload,
            created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, id) DO UPDATE SET
           type = excluded.type,
           status = excluded.status,
           severity = excluded.severity,
           block_id = excluded.block_id,
           execution_id = excluded.execution_id,
           title = excluded.title,
           body = excluded.body,
           payload = excluded.payload,
           resolved_at = excluded.resolved_at`,
      )
      .bind(
        workspaceId,
        notification.id,
        notification.type,
        notification.status,
        notification.severity ?? 'normal',
        notification.blockId,
        notification.executionId,
        notification.title,
        notification.body,
        notification.payload ? JSON.stringify(notification.payload) : null,
        notification.createdAt,
        notification.resolvedAt,
      )
      .run()
  }
}
