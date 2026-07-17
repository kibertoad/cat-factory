import type {
  Notification,
  NotificationPayload,
  NotificationRepository,
  NotificationType,
} from '@cat-factory/kernel'
import {
  notificationSeveritySchema,
  notificationStatusSchema,
  notificationTypeSchema,
} from '@cat-factory/contracts'
import { decodeEnum, decodeEnumOr } from '@cat-factory/server'
import { and, desc, eq, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { DrizzleDb } from '../db/client.js'
import { notifications } from '../db/schema.js'

// Drizzle/Postgres implementation of the notifications port (the Postgres mirror of
// the Worker's `D1NotificationRepository`, migration 0024). Closes the Node parity
// gap so the notification subsystem — and every channel composed onto it, including
// Slack — fires on the Node facade exactly as on the Worker. Behaviourally identical
// to the D1 repo so the cross-runtime conformance suite asserts the same behaviour.

type NotificationRow = typeof notifications.$inferSelect

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

export class DrizzleNotificationRepository implements NotificationRepository {
  constructor(private readonly db: DrizzleDb) {}

  async get(workspaceId: string, id: string): Promise<Notification | null> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspace_id, workspaceId), eq(notifications.id, id)))
      .limit(1)
    return rows[0] ? rowToNotification(rows[0]) : null
  }

  async listOpen(workspaceId: string): Promise<Notification[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.workspace_id, workspaceId), eq(notifications.status, 'open')))
      .orderBy(desc(notifications.created_at))
    return rows.map(rowToNotification)
  }

  async findOpenByBlock(
    workspaceId: string,
    blockId: string,
    type: NotificationType,
  ): Promise<Notification | null> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspace_id, workspaceId),
          eq(notifications.block_id, blockId),
          eq(notifications.type, type),
          eq(notifications.status, 'open'),
        ),
      )
      .orderBy(desc(notifications.created_at))
      .limit(1)
    return rows[0] ? rowToNotification(rows[0]) : null
  }

  async findOpenByType(workspaceId: string, type: NotificationType): Promise<Notification | null> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.workspace_id, workspaceId),
          isNull(notifications.block_id),
          eq(notifications.type, type),
          eq(notifications.status, 'open'),
        ),
      )
      .orderBy(desc(notifications.created_at))
      .limit(1)
    return rows[0] ? rowToNotification(rows[0]) : null
  }

  async upsert(workspaceId: string, notification: Notification): Promise<void> {
    const values = {
      workspace_id: workspaceId,
      id: notification.id,
      type: notification.type,
      status: notification.status,
      block_id: notification.blockId,
      execution_id: notification.executionId,
      title: notification.title,
      body: notification.body,
      payload: notification.payload ? JSON.stringify(notification.payload) : null,
      severity: notification.severity ?? 'normal',
      created_at: notification.createdAt,
      resolved_at: notification.resolvedAt,
    }
    await this.db
      .insert(notifications)
      .values(values)
      .onConflictDoUpdate({
        target: [notifications.workspace_id, notifications.id],
        set: {
          type: values.type,
          status: values.status,
          block_id: values.block_id,
          execution_id: values.execution_id,
          title: values.title,
          body: values.body,
          payload: values.payload,
          severity: values.severity,
          resolved_at: values.resolved_at,
        },
      })
  }

  async claimForAction(
    workspaceId: string,
    id: string,
    resolvedAt: number,
  ): Promise<Notification | null> {
    // Atomic act-claim: flip `open` → `acted` in one conditional UPDATE and return the row.
    // Only the writer that matched `status = 'open'` gets a row back — a concurrent act finds
    // the card already non-open and is handed null, so the side effect fires exactly once.
    // Mirrors the D1 twin.
    const rows = await this.db
      .update(notifications)
      .set({ status: 'acted', resolved_at: resolvedAt })
      .where(
        and(
          eq(notifications.workspace_id, workspaceId),
          eq(notifications.id, id),
          eq(notifications.status, 'open'),
        ),
      )
      .returning()
    return rows[0] ? rowToNotification(rows[0]) : null
  }

  async escalateStaleOpen(workspaceId: string, cutoff: number): Promise<Notification[]> {
    // One statement flips every overdue open card and returns the rows for re-delivery —
    // the sweep never loops per-row upserts. Mirrors the D1 twin.
    const rows = await this.db
      .update(notifications)
      .set({ severity: 'urgent' })
      .where(
        and(
          eq(notifications.workspace_id, workspaceId),
          eq(notifications.status, 'open'),
          or(eq(notifications.severity, 'normal'), isNull(notifications.severity)),
          lte(notifications.created_at, cutoff),
        ),
      )
      .returning()
    return rows.map(rowToNotification)
  }

  async deleteResolvedOlderThan(cutoff: number): Promise<number> {
    // Retention prune: drop terminal (acted/dismissed) cards resolved at or before the
    // cutoff. Open cards are the actionable inbox and are never eligible; a null
    // resolved_at can't be windowed, so it's kept. Mirrors the D1 twin.
    const deleted = await this.db
      .delete(notifications)
      .where(
        and(
          ne(notifications.status, 'open'),
          isNotNull(notifications.resolved_at),
          lte(notifications.resolved_at, cutoff),
        ),
      )
      .returning({ id: notifications.id })
    return deleted.length
  }

  async upsertOpenForBlock(workspaceId: string, notification: Notification): Promise<Notification> {
    // Atomic dedup: the conflict arbiter is the partial unique index on
    // (workspace_id, block_id, type) WHERE status='open'. A second concurrent open raise
    // for the same block/type updates the existing row in place instead of inserting a
    // duplicate. id/severity/created_at/status are deliberately NOT updated so the card
    // keeps its identity, escalated severity and original timestamp across a re-raise.
    // `.returning()` yields the CANONICAL row so the caller delivers the persisted id, not
    // its discarded optimistic one (a concurrent loser would otherwise push a phantom-id card).
    const values = {
      workspace_id: workspaceId,
      id: notification.id,
      type: notification.type,
      status: 'open',
      block_id: notification.blockId,
      execution_id: notification.executionId,
      title: notification.title,
      body: notification.body,
      payload: notification.payload ? JSON.stringify(notification.payload) : null,
      severity: notification.severity ?? 'normal',
      created_at: notification.createdAt,
      resolved_at: notification.resolvedAt,
    }
    const rows = await this.db
      .insert(notifications)
      .values(values)
      .onConflictDoUpdate({
        target: [notifications.workspace_id, notifications.block_id, notifications.type],
        targetWhere: sql`${notifications.status} = 'open'`,
        set: {
          execution_id: values.execution_id,
          title: values.title,
          body: values.body,
          payload: values.payload,
          resolved_at: values.resolved_at,
        },
      })
      .returning()
    return rows[0] ? rowToNotification(rows[0]) : notification
  }
}
