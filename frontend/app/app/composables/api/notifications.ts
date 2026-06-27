import {
  actNotificationContract,
  dismissNotificationContract,
  listNotificationsContract,
} from '@cat-factory/contracts'
import type { ApiContext } from './context'

/** The human-actionable notification inbox (act / dismiss). */
export function notificationsApi({ send, ws }: ApiContext) {
  return {
    // ---- notifications (human-actionable board items) ---------------------
    listNotifications: (workspaceId: string) =>
      send(listNotificationsContract, { pathPrefix: ws(workspaceId) }),

    // Act on a notification (merge the PR / confirm / retry), then resolve it.
    actNotification: (workspaceId: string, id: string) =>
      send(actNotificationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { notificationId: id },
      }),

    // Dismiss a notification without acting.
    dismissNotification: (workspaceId: string, id: string) =>
      send(dismissNotificationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { notificationId: id },
      }),
  }
}
