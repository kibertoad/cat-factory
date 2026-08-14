import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { collectReviewDebt } from '@cat-factory/contracts'
import type { Notification } from '~/types/domain'
import type {
  NotificationRoutingMatrix,
  NotificationSettings,
  NotificationSettingsStatus,
} from '~/types/notifications'
import { ApiError } from '~/composables/api/errors'
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

  /**
   * Per-block "waiting since", derived from the open review-wait cards by the same
   * `collectReviewDebt` the backend's friction check uses. It is the fallback source for the park
   * surfaces that stamp no `step.pausedAt`.
   *
   * Derived HERE rather than in the reader because the reader is per FRAME: `useFrameLanes` runs
   * one instance per mounted service frame and each was re-deriving the same reduction over the
   * WHOLE open list, so a board with n frames paid O(frames x open notifications) on every
   * notification change for one workspace-wide fact. One store computed serves every frame.
   */
  const reviewDebtByBlock = computed(
    () => new Map(collectReviewDebt(open.value).map((d) => [d.blockId, d.waitingSince])),
  )

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

  // ---- the notification manager (per-workspace channel routing) ------------
  // Loaded on demand by the settings panel, never with the board: an inbox reader does not
  // need the routing matrix, and the read 503s on a deployment with no routing store.

  /** The workspace's routing settings, or null unless {@link settingsStatus} is `ready`. */
  const settings = ref<NotificationSettings | null>(null)
  /**
   * How the last load ENDED, as four distinct states rather than a nullable boolean.
   *
   * `unavailable` and `failed` need different reactions and must not be collapsed: the first is
   * settled ("this deployment wired no routing store"), the second is transient and leaves the
   * board's real configuration UNKNOWN. A panel that cannot tell them apart renders the shipped
   * defaults as though they were the board's own, and its save (a full replace) then writes
   * that guess over whatever was stored.
   */
  const settingsStatus = ref<NotificationSettingsStatus>('unloaded')
  const savingSettings = ref(false)

  async function loadSettings() {
    const ws = useWorkspaceStore()
    settingsStatus.value = 'loading'
    try {
      settings.value = await api.getNotificationSettings(ws.requireId())
      settingsStatus.value = 'ready'
    } catch (error) {
      settings.value = null
      // A 503 is the opt-in shape (no routing store wired), not a failure to report: the panel
      // renders the shipped defaults read-only. Anything else is a real error, which the panel
      // states as such AND the caller still sees, so the server's own message reaches the toast.
      if (isUnavailable(error)) {
        settingsStatus.value = 'unavailable'
        return
      }
      settingsStatus.value = 'failed'
      throw error
    }
  }

  /** Replace the routing overrides (a full replace; dropping a cell restores its default). */
  async function updateSettings(matrix: NotificationRoutingMatrix) {
    const ws = useWorkspaceStore()
    savingSettings.value = true
    try {
      settings.value = await api.updateNotificationSettings(ws.requireId(), matrix)
    } finally {
      savingSettings.value = false
    }
  }

  return {
    open,
    hydrate,
    hydrateBaseline,
    upsert,
    byBlock,
    reviewDebtByBlock,
    count,
    act,
    dismiss,
    settings,
    settingsStatus,
    savingSettings,
    loadSettings,
    updateSettings,
  }
})

/**
 * Whether a failed load is the SETTLED "you can't have this" — the facade wired no routing store
 * (503), rather than a transient fault. Only that resolves to `unavailable`; everything else
 * becomes `failed` and propagates, so a later visit retries and the caller can report it.
 */
function isUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 503
}
