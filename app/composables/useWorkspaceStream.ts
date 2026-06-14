import { ref, onScopeDispose } from 'vue'
import type { WorkspaceEvent } from '~/types/domain'

/**
 * Subscribes to the backend's per-workspace WebSocket event stream and keeps the
 * board in sync in real time — the replacement for the old polling clock. Mount
 * once (e.g. on the board page) after the workspace is ready.
 *
 * `execution` events patch the run + its block directly; the coarse `board` event
 * (module materialised, run cancelled) triggers a debounced full refresh. On every
 * (re)connect we refresh once to reconcile anything missed while disconnected, so
 * the server stays the source of truth and a dropped socket self-heals.
 */
export function useWorkspaceStream() {
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()
  const board = useBoardStore()
  const auth = useAuthStore()
  const apiBase = useRuntimeConfig().public.apiBase

  const connected = ref(false)

  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let boardDebounce: ReturnType<typeof setTimeout> | null = null

  // http→ws, https→wss (apiBase is an absolute origin, see nuxt.config.ts).
  const wsBase = String(apiBase).replace(/^http/, 'ws')

  function debouncedBoardRefresh() {
    if (boardDebounce) clearTimeout(boardDebounce)
    boardDebounce = setTimeout(() => void workspace.refresh(), 300)
  }

  function onMessage(raw: string) {
    let event: WorkspaceEvent
    try {
      event = JSON.parse(raw) as WorkspaceEvent
    } catch {
      return
    }
    if (event.type === 'execution') {
      execution.upsert(event.instance)
      if (event.block) board.upsert(event.block)
    } else if (event.type === 'board') {
      debouncedBoardRefresh()
    }
  }

  function connect() {
    if (stopped || !workspace.workspaceId) return
    const token = auth.token ? `?token=${encodeURIComponent(auth.token)}` : ''
    socket = new WebSocket(`${wsBase}/workspaces/${workspace.workspaceId}/events${token}`)

    socket.onopen = () => {
      attempt = 0
      connected.value = true
      // Resync on (re)connect: any event missed while disconnected is reconciled.
      void workspace.refresh()
    }
    socket.onmessage = (e) => onMessage(typeof e.data === 'string' ? e.data : '')
    socket.onclose = () => {
      connected.value = false
      scheduleReconnect()
    }
    socket.onerror = () => socket?.close()
  }

  function scheduleReconnect() {
    if (stopped) return
    socket = null
    const delay = Math.min(30_000, 500 * 2 ** attempt) // 0.5s → 30s cap
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  function start() {
    stopped = false
    connect()
  }

  function stop() {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    if (boardDebounce) clearTimeout(boardDebounce)
    socket?.close()
    socket = null
    connected.value = false
  }

  onScopeDispose(stop)
  return { start, stop, connected }
}
