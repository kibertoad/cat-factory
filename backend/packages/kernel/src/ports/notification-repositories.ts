import type { Notification, NotificationType } from '../domain/types'

// Persistence port for notifications (the canonical store behind the in-app
// inbox). The worker implements it against D1; tests supply an in-memory fake.
// Rows are scoped by workspace and keyed by notification id.

export interface NotificationRepository {
  /** A notification by id, or null if it does not exist. */
  get(workspaceId: string, id: string): Promise<Notification | null>
  /** All currently-open notifications for a workspace (newest first), for the inbox + snapshot. */
  listOpen(workspaceId: string): Promise<Notification[]>
  /**
   * The open notification of `type` for `blockId`, if any — used to de-duplicate so
   * a re-driven run doesn't stack identical cards on the same block.
   */
  findOpenByBlock(
    workspaceId: string,
    blockId: string,
    type: NotificationType,
  ): Promise<Notification | null>
  /** Create or replace a notification (keyed by id). */
  upsert(workspaceId: string, notification: Notification): Promise<void>
}
