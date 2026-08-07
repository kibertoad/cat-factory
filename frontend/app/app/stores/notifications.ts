import { defineStore } from 'pinia'
import { computed } from 'vue'
import type { Notification } from '~/types/domain'
import type { ReviewEffort } from '~/types/merge'
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

  // Client-side monotonic guard against a stale full-snapshot `hydrate` CLOBBERING newer live
  // state — the same hazard `useBoardStore` guards, on the delivery shape that has no second
  // chance. A run raises its card as a targeted `notification` event; a full `refresh()` whose
  // snapshot was READ before that card existed can resolve AFTER it, and a plain replace then
  // drops the card with NO further event to restore it, so the inbox bell never appears (the
  // pr-review e2e flake). Notifications carry no server revision, so each live write is stamped
  // with a monotonic sequence and a refresh that captured its baseline BEFORE the fetch keeps
  // every write newer than that baseline. It cuts both ways: a live-ADDED card the snapshot
  // cannot know about is re-inserted, and a live-RESOLVED one the snapshot still calls open
  // stays gone.
  let liveSeq = 0
  /** Last live write per id: the notification to keep, or `null` once it was resolved. */
  const liveWrites = new Map<string, { seq: number; value: Notification | null }>()

  /**
   * Baseline for {@link hydrate}: capture this BEFORE a refresh's snapshot fetch and pass it
   * back in, so a notification written live while the fetch was in flight survives the hydrate.
   * Callers that don't pass a baseline get a plain full replace (initial load / board switch —
   * no live-write race to guard).
   */
  function hydrateBaseline(): number {
    return liveSeq
  }

  /** Replace the cache from a server snapshot, keeping live writes newer than `since`. */
  function hydrate(notifications: Notification[], since = liveSeq) {
    const newer = new Map<string, Notification | null>()
    for (const [id, write] of liveWrites) {
      // A write the snapshot already reflects is reconciled and can be forgotten, so the map
      // stays bounded by what is genuinely in flight rather than by the session's history.
      if (write.seq > since) newer.set(id, write.value)
      else liveWrites.delete(id)
    }
    const merged = notifications.filter((n) => n.status === 'open' && !newer.has(n.id))
    for (const value of newer.values()) if (value) merged.push(value)
    open.value = merged.sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * Patch one notification from a real-time event: an `open` one is inserted /
   * replaced in place; a resolved one (acted/dismissed) is removed from the inbox.
   */
  function upsert(notification: Notification) {
    const isOpen = notification.status === 'open'
    liveWrites.set(notification.id, { seq: ++liveSeq, value: isOpen ? notification : null })
    if (!isOpen) {
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

  /**
   * Act on a notification (merge / confirm / retry); the board patches via the event.
   *
   * `reviewEffort` is the merge card's one-tap "how much review did this need?" answer, recorded
   * onto the run's merge track record in the same request. Always optional: acting without it
   * merges exactly as before and leaves the record's tag null.
   */
  async function act(id: string, reviewEffort?: ReviewEffort | null) {
    const ws = useWorkspaceStore()
    const resolved = await api.actNotification(ws.requireId(), id, reviewEffort)
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

  return { open, hydrate, hydrateBaseline, upsert, byBlock, count, act, dismiss }
})
