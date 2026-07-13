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
  const environmentTest = useEnvironmentTestStore()
  const notifications = useNotificationsStore()
  const observability = useObservabilityStore()
  const requirements = useRequirementsStore()
  const consensus = useConsensusStore()
  const clarity = useClarityStore()
  const brainstorm = useBrainstormStore()
  const kaizen = useKaizenStore()
  const initiatives = useInitiativesStore()
  const docInterview = useDocInterviewStore()
  const api = useApi()
  const apiBase = useRuntimeConfig().public.apiBase

  const connected = ref(false)
  // Have we EVER been fully live (connected AND reconciled) for the current workspace? Drives the
  // "reconnecting" vs "never connected" distinction in the banner. Set together with `connected`
  // AFTER the on-open resync settles — NOT at `onopen` — so the initial resync window (socket open
  // but not yet announced) can't be mistaken for a re-connection and flash the amber banner.
  const everConnected = ref(false)
  // The very first handshake keeps failing (proxy/firewall blocks WS while REST works, or the
  // ticket mint throws) — the board loaded over REST but will never go live. Flagged after a
  // few failed attempts so the banner can say "not receiving live updates" instead of nothing.
  const connectionFailed = ref(false)
  // Failed connect attempts before we ever go live gates the offline flag above.
  const INITIAL_FAIL_ATTEMPTS = 3

  let socket: WebSocket | null = null
  let stopped = false
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let boardDebounce: ReturnType<typeof setTimeout> | null = null

  // http→ws, https→wss (apiBase is an absolute origin, see nuxt.config.ts).
  const wsBase = String(apiBase).replace(/^http/, 'ws')

  // A coarse board refresh (the resync on reconnect, and the `board` event fan-out) must not be
  // left silently stale by ONE transient failure: retry a few times with backoff so a blip
  // self-heals. Bounded (the socket-level reconnect + the offline banner are the backstop for a
  // genuine outage). Aborts between attempts if the stream stopped or the workspace switched.
  const REFRESH_MAX_ATTEMPTS = 4
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  async function refreshWithRetry(workspaceId: string): Promise<void> {
    for (let i = 0; i < REFRESH_MAX_ATTEMPTS; i++) {
      if (stopped || workspace.workspaceId !== workspaceId) return
      try {
        await workspace.refresh()
        return
      } catch {
        if (i < REFRESH_MAX_ATTEMPTS - 1) await sleep(Math.min(4_000, 400 * 2 ** i))
      }
    }
  }

  function debouncedBoardRefresh() {
    const workspaceId = workspace.workspaceId
    if (!workspaceId) return
    if (boardDebounce) clearTimeout(boardDebounce)
    boardDebounce = setTimeout(() => void refreshWithRetry(workspaceId), 300)
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
    } else if (event.type === 'env-config-repair') {
      // A provider config-repair run advanced — patch its live status/subtasks/outcome so
      // the infrastructure-providers window's "repairing…" indicator updates in place
      // (then flips to ok / residual issues / a failure) without a refetch. No board block.
      agentRuns.upsertEnvConfigRepair(event.job)
    } else if (event.type === 'envTest') {
      // An ephemeral-environment self-test advanced a stage — patch the run so the service
      // inspector's "Test environment creation" control shows the live stage + final
      // outcome in place without a refetch. No board block.
      environmentTest.upsert(event.run)
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
    } else if (event.type === 'brainstorm') {
      // The async incorporate + re-run cycle changed a brainstorm session's status — patch the
      // cache so an open brainstorm window / inspector reflects it live.
      brainstorm.upsert(event.session)
    } else if (event.type === 'kaizen') {
      // A post-run Kaizen grading was scheduled, started or completed — fold it into the
      // run cache (so an open run window shows scheduled→running→complete live) and the
      // Kaizen screen history. Never surfaced on the board.
      kaizen.upsert(event.grading)
    } else if (event.type === 'initiative') {
      // An initiative changed (created, plan ingested, an item settled) — patch the cache
      // so an open tracker window / the board card reflects the transition live.
      initiatives.upsert(event.initiative)
    } else if (event.type === 'docInterview') {
      // The interactive document interview advanced (a fresh batch of questions, an answer, or
      // convergence) — patch the cache so an open interview window reflects it live.
      docInterview.upsert(event.session)
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

    // Carry this tab's stable connection id so the backend can suppress echoing a board
    // mutation's coarse event back to the connection that caused it (same id the api
    // client sends as `X-Connection-Id`) — see `utils/connectionId.ts`.
    const cid = `cid=${encodeURIComponent(connectionId())}`
    const query = ticket ? `?ticket=${encodeURIComponent(ticket)}&${cid}` : `?${cid}`
    socket = new WebSocket(`${wsBase}/workspaces/${workspaceId}/events${query}`)

    socket.onopen = () => {
      attempt = 0
      connectionFailed.value = false
      // Resync on (re)connect BEFORE announcing `connected`: any event missed while
      // disconnected is reconciled first. The snapshot carries `bootstrapJobs` +
      // executions, so one refresh rehydrates agentRuns too — a missed terminal event
      // (e.g. a container eviction that failed the run) can't leave a frame stuck on a
      // stale "bootstrapping…" badge.
      //
      // We flip `connected` only AFTER that refresh settles so it means "connected AND
      // reconciled". Otherwise `board.hydrate`/`agentRuns.hydrate` reconcile with a
      // snapshot fetched at connect time, which — under load — can resolve AFTER a fresh
      // live event and clobber it: e.g. `board.hydrate` REPLACES the block list and drops
      // a just-created provisional bootstrap frame the stale snapshot never saw, so its
      // live "bootstrapping…" badge flickers out with no further board event to restore
      // it. Anything acting on a `connected` board (a user, or an e2e spec gating on
      // `data-connected`) then does so only after this reconcile, so a lagging resync
      // can't drop the state that action produces. The resync RETRIES on a transient
      // failure (`refreshWithRetry`) so a reconnect no longer presents as fully live while
      // silently missing everything from the outage; `connected` is still set even if every
      // retry fails (we ARE connected; a refresh error must not wedge the indicator/tests).
      void refreshWithRetry(workspaceId).finally(() => {
        // A workspace switch (or stop()) may have happened while the refresh was in
        // flight — don't announce a connection for a socket we've since abandoned.
        if (!stopped && socket && workspace.workspaceId === workspaceId) {
          // Flip `everConnected` here (not at onopen): only now are we "fully live", so a later
          // drop reads as a real re-connection while this initial resync window does not.
          everConnected.value = true
          connected.value = true
        }
      })
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
    // If we've never gone live and keep failing, flag the board as offline so the banner can
    // surface a "not receiving live updates" state (a REST-only board otherwise looks fine but
    // silently never updates). Reset the moment a socket opens (see `onopen`).
    if (!everConnected.value && attempt + 1 >= INITIAL_FAIL_ATTEMPTS) connectionFailed.value = true
    const delay = Math.min(30_000, 500 * 2 ** attempt) // 0.5s → 30s cap
    attempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  function start() {
    stopped = false
    // Reset the per-workspace connection lifecycle so a switch to a NEW workspace whose socket
    // fails is flagged offline on its own merits, not masked by the previous workspace's history.
    attempt = 0
    everConnected.value = false
    connectionFailed.value = false
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
  return { start, stop, connected, everConnected, connectionFailed }
}
