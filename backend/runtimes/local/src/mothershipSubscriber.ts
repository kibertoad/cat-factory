import { MACHINE_EVENTS_SUBSCRIBE_PATH, type Logger } from '@cat-factory/server'
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

/** Reconnect backoff bounds for a dropped upstream subscription. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/** The minimal `ws`-shaped socket this module drives (so a test can supply a fake). */
export interface UpstreamSocket {
  on(event: 'open' | 'close' | 'error', listener: () => void): void
  on(event: 'message', listener: (data: unknown) => void): void
  close(): void
}

/** Opens one upstream subscription socket. Injectable so tests need no real server. */
export type UpstreamConnect = (url: string, headers: Record<string, string>) => UpstreamSocket

/**
 * Holds the local node's inbound subscriptions to the mothership's per-workspace event streams,
 * one per workspace with at least one local subscriber.
 *
 * Lifecycle: `bind(sink, rooms)` attaches it to the local realtime hub (rooms drive open/close);
 * `stop()` releases every socket. A node with no machine token yet simply doesn't connect — the
 * board still works, it just isn't live for other people's activity until the login completes, and
 * the next room transition retries.
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
    },
  ) {}

  /**
   * Attach to the local realtime transport: `sink` receives events arriving from the mothership,
   * `rooms` reports which workspaces are being watched locally. `sink` MUST be the bare hub, not a
   * layered propagator (see the file header). Returns a detach function.
   */
  bind(sink: LocalEventSink, rooms: RealtimeRoomWatcher): () => void {
    this.sink = sink
    const listener: RealtimeRoomListener = {
      roomOpened: (workspaceId) => this.open(workspaceId),
      roomClosed: (workspaceId) => this.release(workspaceId),
    }
    this.detachRooms = rooms.watchRooms(listener)
    return () => this.stop()
  }

  /** Workspaces this node currently holds (or is trying to hold) an upstream subscription for. */
  get subscribedWorkspaces(): string[] {
    return [...this.sockets.keys()]
  }

  /** Close every upstream socket and stop reconnecting. Idempotent. */
  stop(): void {
    this.stopped = true
    this.detachRooms?.()
    this.detachRooms = null
    for (const subscription of this.sockets.values()) teardown(subscription)
    this.sockets.clear()
  }

  private open(workspaceId: string): void {
    if (this.stopped || this.sockets.has(workspaceId)) return
    const subscription: Subscription = { socket: null, timer: null, attempt: 0, closed: false }
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
      this.opts.log.warn(
        { workspaceId, err: error instanceof Error ? error.message : String(error) },
        'mothership event subscription failed to open',
      )
      this.scheduleRetry(workspaceId, subscription)
      return
    }
    subscription.socket = socket

    socket.on('open', () => {
      subscription.attempt = 0
      this.opts.log.info({ workspaceId }, 'mothership event subscription open')
    })
    socket.on('message', (data) => this.deliver(workspaceId, data))
    // A dropped subscription is expected (mothership restart, laptop sleep, network blip) and must
    // heal itself, so both terminal signals funnel into the same backoff retry. `ws` always emits
    // `close` after `error`; the guard below makes a double-schedule impossible.
    socket.on('error', () => {})
    socket.on('close', () => {
      if (subscription.socket === socket) subscription.socket = null
      this.scheduleRetry(workspaceId, subscription)
    })
  }

  private deliver(workspaceId: string, data: unknown): void {
    // The mothership relays the exact JSON text frame a browser receives — pass it through
    // verbatim, never re-parsed, exactly as the upstream leg forwards it.
    const payload = typeof data === 'string' ? data : String(data)
    // Keepalive text frames are not events. (Liveness itself is server-driven — the Node hub pings
    // at the protocol level and `ws` auto-pongs; the Cloudflare hub auto-answers an app-level
    // "ping" — so this subscriber sends nothing and simply reconnects if a socket drops, exactly
    // like the browser stream.)
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

  private scheduleRetry(workspaceId: string, subscription: Subscription): void {
    if (subscription.closed || this.stopped || subscription.timer) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** subscription.attempt)
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
  try {
    subscription.socket?.close()
  } catch {
    // Already closing; nothing to release.
  }
}

interface Subscription {
  socket: UpstreamSocket | null
  timer: ReturnType<typeof setTimeout> | null
  attempt: number
  closed: boolean
}

const defaultConnect: UpstreamConnect = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as UpstreamSocket
