import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { PreviewState } from '~/types/domain'
import { useWorkspaceStore } from '~/stores/workspace'

/**
 * The browsable-frontend-preview runtime state, keyed by `frontend` frame id. Distinct from
 * the frame's persisted `frontendConfig.previewEnabled` flag: this is the LIVE resource (a
 * container building/serving the app on a host URL) fetched from the three preview endpoints.
 * The three calls all return the same {@link PreviewState}, so each action just stores the
 * result. While a preview is `starting` the store self-polls until it settles (ready/failed),
 * so the inspector reflects the URL the moment it comes up — no manual refresh.
 */
export const usePreviewStore = defineStore('preview', () => {
  const api = useApi()

  /** frameId → its latest preview state. */
  const byFrame = ref<Record<string, PreviewState>>({})
  /** frameId → a start/stop request is in flight (drives the button loading state). */
  const busy = ref<Record<string, boolean>>({})

  // Active poll timers while a preview is `starting`, so a settled/left preview stops polling.
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const POLL_INTERVAL_MS = 2_500

  function stopPolling(frameId: string) {
    const timer = timers.get(frameId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(frameId)
    }
  }

  function apply(frameId: string, state: PreviewState) {
    byFrame.value[frameId] = state
    if (state.status === 'starting') {
      stopPolling(frameId)
      timers.set(
        frameId,
        setTimeout(() => void refresh(frameId), POLL_INTERVAL_MS),
      )
    } else {
      stopPolling(frameId)
    }
  }

  /** Fetch the current preview state for a frame (used on mount + as the poll tick). */
  async function refresh(frameId: string): Promise<void> {
    const ws = useWorkspaceStore()
    try {
      apply(frameId, await api.getPreview(ws.requireId(), frameId))
    } catch {
      // A transient error leaves the last known state; stop polling so we don't spin.
      stopPolling(frameId)
    }
  }

  /** Start (or restart) the preview for a frame. */
  async function start(frameId: string): Promise<void> {
    const ws = useWorkspaceStore()
    busy.value[frameId] = true
    try {
      apply(frameId, await api.startPreview(ws.requireId(), frameId))
    } finally {
      busy.value[frameId] = false
    }
  }

  /** Stop the preview for a frame. */
  async function stop(frameId: string): Promise<void> {
    const ws = useWorkspaceStore()
    busy.value[frameId] = true
    try {
      stopPolling(frameId)
      apply(frameId, await api.stopPreview(ws.requireId(), frameId))
    } finally {
      busy.value[frameId] = false
    }
  }

  return { byFrame, busy, refresh, start, stop }
})
