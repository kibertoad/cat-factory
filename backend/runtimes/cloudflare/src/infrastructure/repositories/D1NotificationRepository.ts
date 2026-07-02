import type { NotificationRepository } from '@cat-factory/kernel'
import type { Notification, NotificationPayload, NotificationType } from '@cat-factory/contracts'
import {
  notificationSeveritySchema,
  notificationStatusSchema,
  notificationTypeSchema,
} from '@cat-factory/contracts'
import { decodeEnum, decodeEnumOr } from '@cat-factory/server'
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
  const ctx = { table: 'notifications', id: row.id }
  return {
    id: row.id,
    type: decodeEnum(notificationTypeSchema, row.type, { ...ctx, column: 'type' }),
    status: decodeEnum(notificationStatusSchema, row.status, { ...ctx, column: 'status' }),
    severity: decodeEnumOr(notificationSeveritySchema, row.severity ?? 'normal', 'normal', {
      ...ctx,
      column: 'severity',
    }),
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

  async escalateStaleOpen(workspaceId: string, cutoff: number): Promise<Notification[]> {
    // One statement flips every overdue open card and returns the rows for re-delivery —
    // the sweep never loops per-row upserts.
    const { results } = await this.db
      .prepare(
        `UPDATE notifications SET severity = 'urgent'
           WHERE workspace_id = ? AND status = 'open'
             AND (severity = 'normal' OR severity IS NULL)
             AND created_at <= ?
         RETURNING *`,
      )
      .bind(workspaceId, cutoff)
      .all<NotificationRow>()
    return (results ?? []).map(rowToNotification)
  }

  async upsertOpenForBlock(workspaceId: string, notification: Notification): Promise<Notification> {
    // Atomic dedup: the conflict arbiter is the partial unique index on
    // (workspace_id, block_id, type) WHERE status='open' (migration 0023). A second
    // concurrent open raise for the same block/type updates the existing row in place
    // instead of inserting a duplicate. id/severity/created_at/status are deliberately
    // NOT updated so the existing card keeps its identity, escalated severity and
    // original timestamp across a re-raise. RETURNING * yields the CANONICAL row so the
    // caller delivers the persisted id, not its discarded optimistic one (a concurrent
    // loser would otherwise push a phantom-id card).
    const row = await this.db
      .prepare(
        `INSERT INTO notifications
           (workspace_id, id, type, status, severity, block_id, execution_id, title, body, payload,
            created_at, resolved_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (workspace_id, block_id, type) WHERE status = 'open' DO UPDATE SET
           execution_id = excluded.execution_id,
           title = excluded.title,
           body = excluded.body,
           payload = excluded.payload,
           resolved_at = excluded.resolved_at
         RETURNING *`,
      )
      .bind(
        workspaceId,
        notification.id,
        notification.type,
        notification.severity ?? 'normal',
        notification.blockId,
        notification.executionId,
        notification.title,
        notification.body,
        notification.payload ? JSON.stringify(notification.payload) : null,
        notification.createdAt,
        notification.resolvedAt,
      )
      .first<NotificationRow>()
    // RETURNING always yields the inserted-or-updated row for this statement.
    return row ? rowToNotification(row) : notification
  }
}
