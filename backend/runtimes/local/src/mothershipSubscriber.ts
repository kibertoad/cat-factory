import { MACHINE_EVENTS_SUBSCRIBE_PATH, type Logger } from '@cat-factory/server'
import { describeError } from '@cat-factory/kernel'
import type {
  LocalEventSink,
  RealtimeRoomListener,
  RealtimeRoomWatcher,
} from '@cat-factory/node-server'
import { WebSocket } from 'ws'

// Mothership-mode real-time INBOUND subscribe (docs/initiatives/mothership-mode.md, PR 2).
//
// The OUTBOUND half ({@link MothershipWebSocketPropagator}) carries this node's engine events UP
// to the mothership. This is the mirror: org activity raised ELSEWHERE — by a hosted teammate, or
// by a peer laptop relaying upstream — has to come back DOWN, or a mothership-mode board is
// write-only in real time and only ever animates for work this laptop drove itself.
//
// Two design choices worth keeping:
//
// - **Demand-driven, not subscribe-everything.** The node holds one upstream socket per workspace
//   somebody is actually watching, opened off the local hub's room transitions
//   ({@link RealtimeRoomWatcher}). A laptop with no browser attached holds no upstream sockets, and
//   the node never needs a list of the org's workspaces to know what to subscribe to.
// - **Delivery goes to the BARE hub, never back through the layered propagator.** An inbound event
//   re-broadcast through the layer would be re-published upstream — an echo loop. This is the same
//   rule `LayeredEventPropagator.start` follows for its Redis adapter, applied at the wiring seam.
//
// Echo suppression works the other way: this node subscribes with a stable `?cid=`, and the
// OUTBOUND publish stamps that same id as `originConnectionId`, so the mothership's fan-out skips
// the socket that relayed the event to it. Without that, every locally produced event would come
// straight back and be delivered to the laptop's browsers twice.
//
// LIVENESS is client-driven, and it has to be, because the two mothership runtimes do NOT agree on
// who keeps a subscription honest. A Node mothership pings at the protocol level and reaps a socket
// that stops answering, so a drop surfaces as a `close` we can retry. A Cloudflare mothership does
// not: the `WorkspaceEventsHub` uses the hibernation API, which sends no pings, so a half-open
// socket NEVER fires `close` and the workspace would go dark forever while `subscribedWorkspaces`
// still reported it healthy — a silent failure, which is the one shape this whole leg exists to
// avoid. So the subscriber runs its own heartbeat and treats ANY inbound frame as proof of life:
// the app-level `"ping"` it sends is auto-answered `"pong"` at the Cloudflare edge (the DO's
// `setWebSocketAutoResponse` pair, answered without waking the DO), while a Node mothership's own
// protocol ping arrives as a `ping` event. Neither hub reads subscriber frames, so the text ping is
// inert on the runtime that doesn't need it.

/** Reconnect backoff bounds for a dropped upstream subscription. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000
/** How often to probe an idle subscription, and how long silence may last before it is dead. */
const HEARTBEAT_INTERVAL_MS = 30_000
const IDLE_DEADLINE_MS = 90_000
/**
 * Log the first `n` consecutive failures for a workspace, then every `n`th, so a permanently
 * refused subscription (revoked token, board moved out of the token's accounts) is VISIBLE without
 * a line every 30s forever. A silent infinite retry is indistinguishable from a healthy node.
 */
const FAILURE_LOG_EVERY = 5

/** The minimal `ws`-shaped socket this module drives (so a test can supply a fake). */
export interface UpstreamSocket {
  on(event: 'open' | 'close', listener: () => void): void
  /** `ws` hands the error to its listener; it is the only diagnosis of a refused handshake. */
  on(event: 'error', listener: (error: unknown) => void): void
  /** A server protocol ping (Node mothership) or an auto-answered `"pong"` — both mean alive. */
  on(event: 'ping' | 'pong', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  send(data: string): void
  close(): void
}

/** Opens one upstream subscription socket. Injectable so tests need no real server. */
export type UpstreamConnect = (url: string, headers: Record<string, string>) => UpstreamSocket

/**
 * Holds the local node's inbound subscriptions to the mothership's per-workspace event streams,
 * one per workspace with at least one local subscriber.
 *
 * Lifecycle: `bind(sink, rooms)` attaches it to the local realtime hub (rooms drive open/close)
 * and returns a DETACH function that releases the sockets and leaves the subscriber re-bindable;
 * `stop()` is the terminal form, after which nothing reconnects. A node with no machine token yet
 * simply doesn't connect — the board still works, it just isn't live for other people's activity
 * until the login completes, and the pending retry picks the token up.
 */
export class MothershipEventSubscriber {
  private readonly sockets = new Map<string, Subscription>()
  private sink: LocalEventSink | null = null
  private detachRooms: (() => void) | null = null
  private stopped = false

  constructor(
    private readonly opts: {
      baseUrl: string
      /** The machine token, read PER CONNECT so a post-boot login is picked up without a restart. */
      token: () => string | null
      /** This node's stable connection id — the mothership skips echoing our own events back. */
      connectionId: string
      log: Pick<Logger, 'warn' | 'info'>
      connect?: UpstreamConnect
      /** Backoff jitter source; injectable so a test can pin the delay. Defaults to `Math.random`. */
      random?: () => number
    },
  ) {}

  /**
   * Attach to the local realtime transport: `sink` receives events arriving from the mothership,
   * `rooms` reports which workspaces are being watched locally. `sink` MUST be the bare hub, not a
   * layered propagator (see the file header).
   *
   * Returns a detach function: it releases every upstream socket and stops observing rooms, but —
   * unlike {@link stop} — leaves the subscriber usable, so a re-bind reconnects. Binding twice
   * throws rather than silently orphaning the first binding's room watcher.
   */
  bind(sink: LocalEventSink, rooms: RealtimeRoomWatcher): () => void {
    if (this.detachRooms) {
      throw new Error('MothershipEventSubscriber is already bound; detach before re-binding')
    }
    this.stopped = false
    this.sink = sink
    const listener: RealtimeRoomListener = {
      roomOpened: (workspaceId) => this.open(workspaceId),
      roomClosed: (workspaceId) => this.release(workspaceId),
    }
    this.detachRooms = rooms.watchRooms(listener)
    return () => this.detach()
  }

  /** Workspaces this node currently holds (or is trying to hold) an upstream subscription for. */
  get subscribedWorkspaces(): string[] {
    return [...this.sockets.keys()]
  }

  /** Close every upstream socket and stop reconnecting. Idempotent. */
  stop(): void {
    this.stopped = true
    this.detach()
  }

  /** Release the sockets and the room watcher, leaving the subscriber re-bindable. Idempotent. */
  private detach(): void {
    this.detachRooms?.()
    this.detachRooms = null
    this.sink = null
    for (const subscription of this.sockets.values()) teardown(subscription)
    this.sockets.clear()
  }

  private open(workspaceId: string): void {
    if (this.stopped || this.sockets.has(workspaceId)) return
    const subscription: Subscription = {
      socket: null,
      timer: null,
      heartbeat: null,
      lastSeenAt: 0,
      attempt: 0,
      failures: 0,
      closed: false,
    }
    this.sockets.set(workspaceId, subscription)
    this.connect(workspaceId, subscription)
  }

  private release(workspaceId: string): void {
    const subscription = this.sockets.get(workspaceId)
    if (!subscription) return
    this.sockets.delete(workspaceId)
    teardown(subscription)
  }

  private connect(workspaceId: string, subscription: Subscription): void {
    if (subscription.closed) return
    const token = this.opts.token()
    // No token yet (a node booted before the mothership login): don't open a guaranteed-403
    // handshake. The next room transition — or the retry scheduled below — picks up the token
    // once the SPA completes the connect flow.
    if (!token) {
      this.scheduleRetry(workspaceId, subscription)
      return
    }

    const connect = this.opts.connect ?? defaultConnect
    let socket: UpstreamSocket
    try {
      socket = connect(this.subscribeUrl(workspaceId), { authorization: `Bearer ${token}` })
    } catch (error) {
      this.recordFailure(workspaceId, subscription, error)
      this.scheduleRetry(workspaceId, subscription)
      return
    }
    subscription.socket = socket

    socket.on('open', () => {
      subscription.attempt = 0
      subscription.failures = 0
      this.markSeen(subscription)
      this.startHeartbeat(workspaceId, subscription, socket)
      this.opts.log.info('mothership event subscription open', { workspaceId })
    })
    socket.on('message', (data) => {
      this.markSeen(subscription)
      this.deliver(workspaceId, data)
    })
    // A server protocol ping (Node mothership) and the edge-answered `"pong"` (Cloudflare) are not
    // events, but they ARE proof the socket is still carrying traffic — see the file header.
    socket.on('ping', () => this.markSeen(subscription))
    socket.on('pong', () => this.markSeen(subscription))
    // A refused handshake reports ONLY here (`ws` emits `error` then `close`, and the close carries
    // no reason for an HTTP-level rejection), so swallowing it is what makes a permanently broken
    // subscription look identical to a healthy one. Record it; `close` still drives the retry.
    socket.on('error', (error) => this.recordFailure(workspaceId, subscription, error))
    socket.on('close', () => {
      if (subscription.socket === socket) subscription.socket = null
      this.clearHeartbeat(subscription)
      this.scheduleRetry(workspaceId, subscription)
    })
  }

  private deliver(workspaceId: string, data: unknown): void {
    // The mothership relays the exact JSON text frame a browser receives — pass it through
    // verbatim, never re-parsed, exactly as the upstream leg forwards it.
    const payload = typeof data === 'string' ? data : String(data)
    // Keepalive text frames are not events: the `"pong"` answering our own heartbeat, and a `"ping"`
    // from a hub that ever sends one. Both already counted as liveness by the caller.
    if (payload === 'pong' || payload === 'ping') return
    try {
      // Origin id is deliberately NOT threaded: this event came from elsewhere, so every local
      // socket should see it.
      this.sink?.broadcast(workspaceId, payload)
    } catch {
      // Best-effort delivery, matching every other realtime publish path: a broadcast hiccup
      // must never tear down the subscription. The SPA reconciles on its own resync.
    }
  }

  private markSeen(subscription: Subscription): void {
    subscription.lastSeenAt = Date.now()
  }

  /**
   * Probe an idle subscription and give up on a silent one (see the file header): if nothing has
   * arrived for {@link IDLE_DEADLINE_MS} the socket is half-open — a state a Cloudflare mothership
   * will never close for us — so drop it and let the close handler retry. Otherwise send the
   * app-level `"ping"` whose answer proves the link is still there.
   */
  private startHeartbeat(
    workspaceId: string,
    subscription: Subscription,
    socket: UpstreamSocket,
  ): void {
    this.clearHeartbeat(subscription)
    subscription.heartbeat = setInterval(() => {
      if (Date.now() - subscription.lastSeenAt > IDLE_DEADLINE_MS) {
        this.opts.log.warn('mothership event subscription went silent; reconnecting', {
          workspaceId,
        })
        this.clearHeartbeat(subscription)
        try {
          socket.close()
        } catch {
          // Already gone; the close handler still schedules the retry.
        }
        return
      }
      try {
        socket.send('ping')
      } catch {
        // A send failure on a dying socket is not worth reporting: the close handler is next.
      }
    }, HEARTBEAT_INTERVAL_MS)
    subscription.heartbeat.unref?.()
  }

  private clearHeartbeat(subscription: Subscription): void {
    if (subscription.heartbeat) clearInterval(subscription.heartbeat)
    subscription.heartbeat = null
  }

  /**
   * Report a failed subscription attempt. Rate-limited (see {@link FAILURE_LOG_EVERY}) because the
   * retry loop is unbounded by design: a token-less or refused node must keep trying, but it must
   * not be indistinguishable from a working one in the logs.
   */
  private recordFailure(workspaceId: string, subscription: Subscription, error: unknown): void {
    subscription.failures += 1
    if (
      subscription.failures > FAILURE_LOG_EVERY &&
      subscription.failures % FAILURE_LOG_EVERY !== 0
    )
      return
    this.opts.log.warn('mothership event subscription failed', {
      workspaceId,
      attempts: subscription.failures,
      ...describeError(error),
    })
  }

  private scheduleRetry(workspaceId: string, subscription: Subscription): void {
    if (subscription.closed || this.stopped || subscription.timer) return
    // Equal jitter: half the window fixed, half random. Without it every workspace subscription on
    // every node retries in lockstep after a mothership restart — the fleet is small today, but a
    // synchronised herd is exactly what a backoff is supposed to prevent.
    const span = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** subscription.attempt)
    const random = this.opts.random ?? Math.random
    const delay = Math.round(span / 2 + random() * (span / 2))
    subscription.attempt = Math.min(subscription.attempt + 1, 10)
    subscription.timer = setTimeout(() => {
      subscription.timer = null
      this.connect(workspaceId, subscription)
    }, delay)
    // Never hold the process open on a reconnect timer.
    subscription.timer.unref?.()
  }

  /** `http(s)://host/internal/events/subscribe/<ws>?cid=<node>` as a `ws(s)` URL. */
  private subscribeUrl(workspaceId: string): string {
    const base = this.opts.baseUrl.replace(/\/$/, '').replace(/^http/, 'ws')
    const cid = encodeURIComponent(this.opts.connectionId)
    return `${base}${MACHINE_EVENTS_SUBSCRIBE_PATH}/${encodeURIComponent(workspaceId)}?cid=${cid}`
  }
}

/**
 * Retire one subscription for good: mark it closed (so a pending retry and the socket's own close
 * handler both no-op), drop its timer, and release the socket.
 */
function teardown(subscription: Subscription): void {
  subscription.closed = true
  if (subscription.timer) clearTimeout(subscription.timer)
  if (subscription.heartbeat) clearInterval(subscription.heartbeat)
  subscription.heartbeat = null
  try {
    subscription.socket?.close()
  } catch {
    // Already closing; nothing to release.
  }
}

interface Subscription {
  socket: UpstreamSocket | null
  timer: ReturnType<typeof setTimeout> | null
  /** The liveness probe for THIS socket; cleared on every close so a dead one can't keep pinging. */
  heartbeat: ReturnType<typeof setInterval> | null
  /** When this subscription last saw any inbound frame — the input to the idle deadline. */
  lastSeenAt: number
  attempt: number
  /** Consecutive failed attempts, for the rate-limited failure log. Reset on a successful open. */
  failures: number
  closed: boolean
}

const defaultConnect: UpstreamConnect = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as UpstreamSocket
