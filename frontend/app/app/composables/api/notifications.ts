import type { Notification } from '~/types/notifications'
import type { ApiContext } from './context'

/** The human-actionable notification inbox (act / dismiss). */
export function notificationsApi({ http, ws }: ApiContext) {
  return {
    // ---- notifications (human-actionable board items) ---------------------
    listNotifications: (workspaceId: string) =>
      http<Notification[]>(`${ws(workspaceId)}/notifications`),

    // Act on a notification (merge the PR / confirm / retry), then resolve it.
    actNotification: (workspaceId: string, id: string) =>
      http<Notification>(`${ws(workspaceId)}/notifications/${encodeURIComponent(id)}/act`, {
        method: 'POST',
      }),

    // Dismiss a notification without acting.
    dismissNotification: (workspaceId: string, id: string) =>
      http<Notification>(`${ws(workspaceId)}/notifications/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST',
      }),
  }
}
