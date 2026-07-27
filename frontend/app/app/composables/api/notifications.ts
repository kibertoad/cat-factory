import {
  actNotificationContract,
  dismissNotificationContract,
  listNotificationsContract,
} from '@cat-factory/contracts'
import type { ReviewEffort } from '~/types/merge'
import type { ApiContext } from './context'

/** The human-actionable notification inbox (act / dismiss). */
export function notificationsApi({ send, ws }: ApiContext) {
  return {
    // ---- notifications (human-actionable board items) ---------------------
    listNotifications: (workspaceId: string) =>
      send(listNotificationsContract, { pathPrefix: ws(workspaceId) }),

    // Act on a notification (merge the PR / confirm / retry), then resolve it. On a merge card,
    // `reviewEffort` records how much review the PR actually needed onto the run's merge track
    // record in the SAME request — always optional (an untagged merge records a null tag).
    actNotification: (workspaceId: string, id: string, reviewEffort?: ReviewEffort | null) =>
      send(actNotificationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { notificationId: id },
        body: reviewEffort === undefined ? {} : { reviewEffort },
      }),

    // Dismiss a notification without acting.
    dismissNotification: (workspaceId: string, id: string) =>
      send(dismissNotificationContract, {
        pathPrefix: ws(workspaceId),
        pathParams: { notificationId: id },
      }),
  }
}
