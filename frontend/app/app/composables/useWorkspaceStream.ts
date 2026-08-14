import { ref, onScopeDispose } from 'vue'
import type { WorkspaceEvent } from '~/types/domain'
import { wsOriginFor } from '~/utils/apiOrigin'
import {
  applyWorkspaceEvent,
  type WorkspaceEventTargets,
} from '~/composables/workspaceStream/applyWorkspaceEvent'

/**
 * Subscribes to the backend's per-workspace WebSocket event stream and keeps the
 * board in sync in real time — the replacement for the old polling clock. Mount
 * once (e.g. on the board page) after the workspace is ready.
 *
 * `execution` events patch the run + its block directly; `bootstrap` events patch
 * a repo-bootstrap run + its service frame (live "bootstrapping…" progress); a
 * `board` event patches the block it carries, or triggers a debounced full refresh when it
 * carries none (a removal, a reparent, a service-frame change). On every (re)connect we refresh
 * once to reconcile anything missed while disconnected, so the server stays the source of truth
 * and a dropped socket self-heals. Routing lives in {@link applyWorkspaceEvent}.
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

  // http→ws, https→wss. `apiBase` is an absolute origin on a split-origin deployment (see
  // nuxt.config.ts) and EMPTY on a same-origin one (one proxy in front of the SPA + the API —
  // the compose preview stack), where the socket origin comes from the page instead.
  const wsBase = wsOriginFor(String(apiBase), import.meta.client ? window.location.origin : '')

  // A coarse board refresh (the resync on reconnect, and the `board` event fan-out) must not be
  // left silently stale by ONE transient failure: retry a few times with backoff so a blip
  // self-heals. Bounded (the socket-level reconnect + the offline banner are the backstop for a
  // genuine outage). Aborts between attempts if the stream stopped or the workspace switched.
  //
  // A chain also stands down when a NEWER one has started: the backoff sleeps run for seconds, so
  // a sustained event stream used to leave several chains alive at once, each still issuing full
  // snapshot fetches for a resync a later chain had already superseded.
  const REFRESH_MAX_ATTEMPTS = 4
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  let refreshChain = 0
  async function refreshWithRetry(workspaceId: string): Promise<void> {
    const chain = ++refreshChain
    for (let i = 0; i < REFRESH_MAX_ATTEMPTS; i++) {
      if (stopped || workspace.workspaceId !== workspaceId || chain !== refreshChain) return
      try {
        await workspace.refresh()
        return
      } catch {
        if (i < REFRESH_MAX_ATTEMPTS - 1) await sleep(Math.min(4_000, 400 * 2 ** i))
      }
    }
  }

  // The coarse-event debounce. Trailing, so a burst of `board` events costs one refresh, and
  // CAPPED, because trailing alone re-armed the timer forever under a sustained sub-300ms stream:
  // the board stopped resyncing exactly when the workspace was busiest. Past the cap the pending
  // refresh fires on schedule and the next event starts a fresh window.
  const BOARD_DEBOUNCE_MS = 300
  const BOARD_DEBOUNCE_MAX_WAIT_MS = 2_000
  let debounceWindowStart = 0
  // The funnel's coverage mark as of the LATEST coarse event in this window. A snapshot fetch
  // issued after that event necessarily contains what the event announced (the server emits it
  // after committing), so if one has already hydrated by the time the timer fires there is nothing
  // left to resync. This is what stops a mutation that refreshes directly AND raises a coarse
  // event from paying for two full snapshots.
  let coverageMark = 0

  function debouncedBoardRefresh() {
    const workspaceId = workspace.workspaceId
    if (!workspaceId) return
    const now = Date.now()
    coverageMark = workspace.refreshMark()
    if (boardDebounce) clearTimeout(boardDebounce)
    else debounceWindowStart = now
    const wait = Math.max(
      0,
      Math.min(BOARD_DEBOUNCE_MS, debounceWindowStart + BOARD_DEBOUNCE_MAX_WAIT_MS - now),
    )
    boardDebounce = setTimeout(() => {
      boardDebounce = null
      if (workspace.hydratedSince(coverageMark)) return
      void refreshWithRetry(workspaceId)
    }, wait)
  }

  // The stores this stream feeds, bound once. Routing lives in `applyWorkspaceEvent` so the
  // targeted-vs-coarse decision on a `board` event is unit-testable without a socket.
  const targets: WorkspaceEventTargets = {
    upsertExecution: (instance) => execution.upsert(instance),
    upsertBlock: (block) => board.upsert(block),
    upsertBootstrap: (job) => agentRuns.upsertBootstrap(job),
    upsertEnvConfigRepair: (job) => agentRuns.upsertEnvConfigRepair(job),
    upsertEnvironmentTest: (run) => environmentTest.upsert(run),
    patchInfraSetup: (area, status, detail) => workspace.patchInfraSetup(area, status, detail),
    upsertNotification: (n) => notifications.upsert(n),
    appendLlmCall: (call) => observability.appendCall(call),
    upsertRequirements: (r) => requirements.upsert(r),
    upsertConsensus: (s) => consensus.upsert(s),
    upsertClarity: (r) => clarity.upsert(r),
    upsertBrainstorm: (s) => brainstorm.upsert(s),
    upsertKaizen: (g) => kaizen.upsert(g),
    upsertInitiative: (i) => initiatives.upsert(i),
    upsertDocInterview: (s) => docInterview.upsert(s),
    refreshBoard: () => debouncedBoardRefresh(),
  }

  function onMessage(raw: string) {
    let event: WorkspaceEvent
    try {
      event = JSON.parse(raw) as WorkspaceEvent
    } catch {
      return
    }
    applyWorkspaceEvent(event, targets)
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
