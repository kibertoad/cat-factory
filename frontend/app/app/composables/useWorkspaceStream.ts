import { ref, onScopeDispose } from 'vue'
import type { WorkspaceEvent } from '~/types/domain'

/**
 * Subscribes to the backend's per-workspace WebSocket event stream and keeps the
 * board in sync in real time — the replacement for the old polling clock. Mount
 * once (e.g. on the board page) after the workspace is ready.
 *
 * `execution` events patch the run + its block directly; `bootstrap` events patch
 * a repo-bootstrap run + its service frame (live "bootstrapping…" progress); the
 * coarse `board` event (module materialised, run cancelled) triggers a debounced
 * full refresh. On every (re)connect we refresh once to reconcile anything missed
 * while disconnected, so the server stays the source of truth and a dropped socket
 * self-heals.
 */
export function useWorkspaceStream() {
  const workspace = useWorkspaceStore()
  const execution = useExecutionStore()
  const board = useBoardStore()
  const agentRuns = useAgentRunsStore()
  const notifications = useNotificationsStore()
  const observability = useObservabilityStore()
  const requirements = useRequirementsStore()
  const consensus = useConsensusStore()
  const clarity = useClarityStore()
  const kaizen = useKaizenStore()
  const api = useApi()
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
      // Full instance drives the step-level UI; agentRuns derives its coarse
      // failure/retry summary from the same store, so no extra call is needed.
      execution.upsert(event.instance)
      if (event.block) board.upsert(event.block)
    } else if (event.type === 'board') {
      debouncedBoardRefresh()
    } else if (event.type === 'bootstrap') {
      // Patch the run's live status/subtasks and its provisional/linked frame so
      // the "bootstrapping…" card updates in place (then flips to a ready service
      // or a failed badge) without a full refresh.
      agentRuns.upsertBootstrap(event.job)
      if (event.block) board.upsert(event.block)
    } else if (event.type === 'notification') {
      // A PR needs a merge decision, a pipeline finished, or CI gave up — patch the
      // inbox + per-block badge in place (resolved ones drop out of the inbox).
      notifications.upsert(event.notification)
    } else if (event.type === 'llmCall') {
      // A container agent just made a model call — fold the compact summary into the
      // observability store so an open "Model activity" panel updates live (and keeps
      // updating even when the durable driver is evicted: the proxy emits these
      // independently of the run's poll loop).
      observability.appendCall(event.call)
    } else if (event.type === 'requirements') {
      // The async incorporate + re-review cycle changed a review's status — patch the cache
      // so an open review window / inspector reflects it live ("incorporating…" → the next
      // cycle / converged). The summons back, when needed, arrives as a `notification`.
      requirements.upsert(event.review)
    } else if (event.type === 'consensus') {
      // A consensus session advanced (a round landed, the synthesis completed, or it
      // failed) — patch the cache so an open Consensus Session window renders the
      // multi-model process live, round by round.
      consensus.upsert(event.session)
    } else if (event.type === 'clarity') {
      // The async incorporate + re-review cycle changed a clarity review's status — patch the
      // cache so an open review window / inspector reflects it live ("incorporating…" → the
      // next cycle / converged). The summons back, when needed, arrives as a `notification`.
      clarity.upsert(event.review)
    } else if (event.type === 'kaizen') {
      // A post-run Kaizen grading was scheduled, started or completed — fold it into the
      // run cache (so an open run window shows scheduled→running→complete live) and the
      // Kaizen screen history. Never surfaced on the board.
      kaizen.upsert(event.grading)
    }
  }

  async function connect() {
    if (stopped || !workspace.workspaceId) return
    const workspaceId = workspace.workspaceId

    // A browser can't set Authorization on a WS handshake, so mint a short-lived,
    // workspace-scoped ticket over the authenticated REST channel and pass it as
    // `?ticket=`. Empty when auth is disabled (dev) — the handshake is open then.
    let ticket: string
    try {
      ticket = (await api.mintEventsTicket(workspaceId)).ticket
    } catch {
      // Couldn't mint (offline, token lapsed) — back off and retry.
      scheduleReconnect()
      return
    }
    // A workspace switch (or stop()) may have happened while awaiting the mint.
    if (stopped || workspace.workspaceId !== workspaceId) return

    const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : ''
    socket = new WebSocket(`${wsBase}/workspaces/${workspaceId}/events${query}`)

    socket.onopen = () => {
      attempt = 0
      connected.value = true
      // Resync on (re)connect: any event missed while disconnected is reconciled.
      // The snapshot carries `bootstrapJobs` + executions, so one refresh rehydrates
      // agentRuns too — a missed terminal event (e.g. a container eviction that
      // failed the run) can't leave a frame stuck on a stale "bootstrapping…" badge.
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
