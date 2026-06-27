import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { Notification } from '~/types/domain'
import { useUpsertList } from '~/composables/useUpsertList'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * Open, human-actionable notifications surfaced on the board (a PR awaiting a
 * merge decision, a completed pipeline awaiting confirmation, CI that gave up).
 * Hydrated from the workspace snapshot and patched live by the `notification`
 * WorkspaceEvent (see `useWorkspaceStream`). The board renders an inbox + a
 * per-block badge from `open` / `byBlock`.
 */
export const useNotificationsStore = defineStore('notifications', () => {
  const api = useApi()

  /** All open notifications, newest-first. */
  const {
    items: open,
    upsert: upsertOpen,
    remove,
  } = useUpsertList<Notification>({ key: (n) => n.id, prepend: true })

  /** Replace the cache from a server snapshot. */
  function hydrate(notifications: Notification[]) {
    open.value = [...notifications]
      .filter((n) => n.status === 'open')
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Patch one notification from a real-time event: an `open` one is inserted /
   * replaced in place; a resolved one (acted/dismissed) is removed from the inbox.
   */
  function upsert(notification: Notification) {
    if (notification.status !== 'open') {
      remove(notification.id)
      return
    }
    upsertOpen(notification)
  }

  /** Open notifications for a given block (for the board card badge). */
  const byBlock = computed<Record<string, Notification[]>>(() => {
    const map: Record<string, Notification[]> = {}
    for (const n of open.value) {
      if (!n.blockId) continue
      ;(map[n.blockId] ??= []).push(n)
    }
    return map
  })

  /** Total open count, for the toolbar badge. */
  const count = computed(() => open.value.length)

  /** Act on a notification (merge / confirm / retry); the board patches via the event. */
  async function act(id: string) {
    const ws = useWorkspaceStore()
    const resolved = await api.actNotification(ws.requireId(), id)
    upsert(resolved)
    // The action (merge/confirm/retry) changed block/run state — reconcile fully.
    await ws.refresh()
  }

  /** Dismiss a notification without acting. */
  async function dismiss(id: string) {
    const ws = useWorkspaceStore()
    const resolved = await api.dismissNotification(ws.requireId(), id)
    upsert(resolved)
  }

  return { open, hydrate, upsert, byBlock, count, act, dismiss }
})
