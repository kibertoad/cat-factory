import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type {
  Block,
  BootstrapJob,
  BrainstormSession,
  ConsensusSession,
  ClarityReview,
  DocInterviewSession,
  EnvConfigRepairJob,
  EnvironmentTestRun,
  ExecutionInstance,
  Initiative,
  KaizenGrading,
  LlmCallActivity,
  Notification,
  RequirementReview,
  WorkspaceEvent,
} from '@cat-factory/contracts'
import {
  type BoardChange,
  boardWireEvent,
  bootstrapWireEvent,
  describeError,
  type ExecutionEventPublisher,
  type InfraSetupTransition,
  type Logger,
} from '@cat-factory/kernel'
import {
  type AccountOfWorkspace,
  type AuthConfig,
  MACHINE_EVENTS_SUBSCRIBE_PATTERN,
  type MachineSubscribeRefusalStatus,
  authorizeMachineSubscribe,
  authorizeWsUpgrade,
  logger,
} from '@cat-factory/server'
import { WebSocket, WebSocketServer } from 'ws'

// The Node service's real-time transport — the analogue of the Worker's per-workspace
// WorkspaceEventsHub Durable Object. The browser SPA opens the SAME raw WebSocket the
// Worker serves (`GET /workspaces/:ws/events?ticket=…`, JSON text frames), so nothing
// on the client changes between runtimes. We use the `ws` library directly rather than
// socket.io (which needs its own client + wire protocol the SPA doesn't speak) or
// `@hono/node-ws` (whose `upgradeWebSocket` middleware can't compose with the shared,
// Response-returning EventsController): `@hono/node-server` doesn't upgrade on its own,
// so we attach a `ws` server to the HTTP server's `upgrade` event in {@link attachRealtime}.

/** The subset of a Node HTTP/HTTP2 server we attach the upgrade listener to. */
interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void
}

const WS_EVENTS_PATH = /^\/workspaces\/([^/]+)\/events$/

/**
 * The narrow write side of the real-time transport: fan a pre-serialised workspace event
 * out to the sockets it should reach. {@link NodeRealtimeHub} implements it for the LOCAL
 * process; the layered {@link LayeredEventPropagator} (see `propagator.ts`) implements the
 * SAME shape by additionally forwarding to peer nodes over a cross-node adapter (e.g.
 * Redis). {@link NodeEventPublisher} writes through this seam so a single-node deployment
 * (local mode) and a multi-node one differ only in which sink is wired — no other code
 * changes between them.
 */
export interface LocalEventSink {
  broadcast(workspaceId: string, payload: string, originConnectionId?: string | null): void
}

/**
 * Notified as a workspace's subscriber room transitions between empty and non-empty. Exists for
 * mothership mode: a local node must hold an UPSTREAM subscription to the mothership for each
 * workspace someone is actually watching, and this is the signal for when to open and release one
 * (see `@cat-factory/local-server`'s `MothershipEventSubscriber`).
 *
 * Demand-driven rather than "subscribe to everything at boot" because the node has no list of the
 * org's workspaces without asking, and an idle laptop should hold no upstream sockets at all.
 */
export interface RealtimeRoomListener {
  /** A workspace gained its FIRST subscriber. */
  roomOpened(workspaceId: string): void
  /** A workspace lost its LAST subscriber. */
  roomClosed(workspaceId: string): void
}

/** The narrow seam a {@link RealtimeRoomListener} attaches to (implemented by {@link NodeRealtimeHub}). */
export interface RealtimeRoomWatcher {
  /** Register a listener; returns a detach function. At most one listener is supported. */
  watchRooms(listener: RealtimeRoomListener): () => void
}

/**
 * Per-workspace subscriber registry. Every browser subscribed to a workspace's stream
 * converges here, so a published event fans out to all of them. In-memory and
 * single-process: the Node service runs as one process (unlike the Worker's globally
 * addressed Durable Object), which is the right model for the self-hosted / local
 * deployments this facade targets. A multi-replica deployment fronts this with a
 * cross-node {@link LayeredEventPropagator} adapter (Redis today) so an event published on
 * one node reaches browsers connected to another — see `propagator.ts`. Single-node / local
 * mode needs none of that: the bare hub IS the sink.
 */
export class NodeRealtimeHub implements LocalEventSink, RealtimeRoomWatcher {
  private readonly rooms = new Map<string, Set<WebSocket>>()
  // The `?cid=` each socket connected with — used to skip echoing a board mutation back to
  // the connection that caused it (the Node analogue of the DO's serialized attachment).
  private readonly connectionIds = new WeakMap<WebSocket, string>()
  private roomListener: RealtimeRoomListener | null = null

  /**
   * Observe room open/close transitions (see {@link RealtimeRoomWatcher}). Best-effort in the one
   * direction that matters: a listener that throws must never break a subscribe/unsubscribe, since
   * the socket lifecycle is the transport's core job and the listener is an optional
   * mothership-mode add-on.
   *
   * At most ONE listener, and a second registration THROWS rather than replacing the first: silent
   * replacement would leave the displaced observer believing it is still watching (a mothership
   * node that never learns a room opened holds no upstream stream and the board just stays frozen),
   * which is precisely the class of quiet breakage this seam exists to serve.
   */
  watchRooms(listener: RealtimeRoomListener): () => void {
    if (this.roomListener) {
      throw new Error('NodeRealtimeHub already has a room listener; detach before re-registering')
    }
    this.roomListener = listener
    return () => {
      if (this.roomListener === listener) this.roomListener = null
    }
  }

  private notifyRoom(event: 'roomOpened' | 'roomClosed', workspaceId: string): void {
    try {
      this.roomListener?.[event](workspaceId)
    } catch {
      // See watchRooms: the listener is an add-on, the socket lifecycle is not.
    }
  }

  /** Add a socket to a workspace's room; it is reaped on close/error. */
  subscribe(workspaceId: string, socket: WebSocket, connectionId?: string | null): void {
    let room = this.rooms.get(workspaceId)
    if (!room) {
      room = new Set()
      this.rooms.set(workspaceId, room)
    }
    const wasEmpty = room.size === 0
    room.add(socket)
    if (wasEmpty) this.notifyRoom('roomOpened', workspaceId)
    if (connectionId) this.connectionIds.set(socket, connectionId)
    const drop = () => this.unsubscribe(workspaceId, socket)
    socket.on('close', drop)
    socket.on('error', drop)
  }

  private unsubscribe(workspaceId: string, socket: WebSocket): void {
    const room = this.rooms.get(workspaceId)
    if (!room) return
    room.delete(socket)
    if (room.size === 0) {
      this.rooms.delete(workspaceId)
      this.notifyRoom('roomClosed', workspaceId)
    }
  }

  /**
   * Fan a pre-serialised JSON event out to every socket on a workspace's stream. When
   * `originConnectionId` is given, the socket that connected with that `?cid=` is skipped:
   * it caused the change and already holds the authoritative REST result, so re-delivering
   * the echo would only make it refresh off (and fight) its own move.
   */
  broadcast(workspaceId: string, payload: string, originConnectionId?: string | null): void {
    const room = this.rooms.get(workspaceId)
    if (!room) return
    for (const socket of room) {
      if (socket.readyState !== WebSocket.OPEN) continue
      if (originConnectionId && this.connectionIds.get(socket) === originConnectionId) continue
      try {
        socket.send(payload)
      } catch {
        // Socket is mid-close; its close handler reaps it. Ignore.
      }
    }
  }
}

/**
 * Pushes execution/board events to the {@link NodeRealtimeHub}, which fans them out to
 * subscribed browsers. The event shapes are IDENTICAL to the Worker's
 * `DurableObjectEventPublisher`, so the SPA's stream handling is runtime-agnostic.
 * Best-effort: a publish failure must never break a state transition (the persisted
 * row is the source of truth and clients reconcile on reconnect), so each publish
 * swallows its own errors.
 */
export class NodeEventPublisher implements ExecutionEventPublisher {
  // Writes through the {@link LocalEventSink} seam, not the concrete hub: the standard boot
  // wires the layered propagator (local hub + cross-node adapters) here so events also reach
  // browsers on peer nodes, while local mode wires the bare hub. Either way this class is
  // unchanged.
  constructor(private readonly sink: LocalEventSink) {}

  /**
   * Publishes stay best-effort, but no longer SILENT — see the Worker twin
   * (`DurableObjectEventPublisher`) for the reasoning and the identical `warn` level.
   */
  private readonly log = logger.child({ publisher: 'node-hub' })

  async executionChanged(
    workspaceId: string,
    instance: ExecutionInstance,
    block?: Block | null,
  ): Promise<void> {
    this.publish(workspaceId, {
      type: 'execution',
      instance,
      block: block ?? null,
      at: Date.now(),
    })
  }

  async boardChanged(workspaceId: string, change: BoardChange): Promise<void> {
    // Assembled by the shared kernel builder, the same one the Worker twin
    // (`DurableObjectEventPublisher.boardChanged`) calls, so the two runtimes cannot drift over
    // which payloads may ride. Pass the origin connection through so the hub skips echoing this
    // board mutation back to the connection that caused it (see {@link NodeRealtimeHub.broadcast}).
    this.publish(workspaceId, boardWireEvent(change, Date.now()), change.originConnectionId)
  }

  async bootstrapChanged(
    workspaceId: string,
    job: BootstrapJob,
    block?: Block | null,
  ): Promise<void> {
    this.publish(workspaceId, bootstrapWireEvent(job, block, Date.now()))
  }

  async envConfigRepairChanged(workspaceId: string, job: EnvConfigRepairJob): Promise<void> {
    this.publish(workspaceId, { type: 'env-config-repair', job, at: Date.now() })
  }

  async envTestChanged(workspaceId: string, run: EnvironmentTestRun): Promise<void> {
    this.publish(workspaceId, { type: 'envTest', run, at: Date.now() })
  }

  async notificationChanged(workspaceId: string, notification: Notification): Promise<void> {
    this.publish(workspaceId, { type: 'notification', notification, at: Date.now() })
  }

  async infraSetupChanged(workspaceId: string, change: InfraSetupTransition): Promise<void> {
    this.publish(workspaceId, { type: 'infraSetup', ...change, at: Date.now() })
  }

  async llmCallObserved(workspaceId: string, activity: LlmCallActivity): Promise<void> {
    this.publish(workspaceId, { type: 'llmCall', call: activity, at: Date.now() })
  }

  async requirementReviewChanged(workspaceId: string, review: RequirementReview): Promise<void> {
    this.publish(workspaceId, { type: 'requirements', review, at: Date.now() })
  }

  async consensusSessionChanged(workspaceId: string, session: ConsensusSession): Promise<void> {
    this.publish(workspaceId, { type: 'consensus', session, at: Date.now() })
  }

  async clarityReviewChanged(workspaceId: string, review: ClarityReview): Promise<void> {
    this.publish(workspaceId, { type: 'clarity', review, at: Date.now() })
  }

  async brainstormSessionChanged(workspaceId: string, session: BrainstormSession): Promise<void> {
    this.publish(workspaceId, { type: 'brainstorm', session, at: Date.now() })
  }

  async kaizenGradingChanged(workspaceId: string, grading: KaizenGrading): Promise<void> {
    this.publish(workspaceId, { type: 'kaizen', grading, at: Date.now() })
  }

  async initiativeChanged(workspaceId: string, initiative: Initiative): Promise<void> {
    this.publish(workspaceId, { type: 'initiative', initiative, at: Date.now() })
  }

  async docInterviewChanged(workspaceId: string, session: DocInterviewSession): Promise<void> {
    this.publish(workspaceId, { type: 'docInterview', session, at: Date.now() })
  }

  private publish(
    workspaceId: string,
    event: WorkspaceEvent,
    originConnectionId?: string | null,
  ): void {
    try {
      this.sink.broadcast(workspaceId, JSON.stringify(event), originConnectionId)
    } catch (error) {
      this.log.warn('realtime publish failed; browsers may be stale until they resync', {
        workspaceId,
        eventType: event.type,
        ...describeError(error),
      })
    }
  }
}

/** How often to ping idle sockets to detect (and reap) half-open connections. */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Status-line reasons for a refused machine subscription. Keyed by the exact statuses
 * {@link authorizeMachineSubscribe} can return, so a new verdict status fails `tsc` here rather
 * than writing `undefined` into a raw HTTP status line (a `Partial` here would trade the
 * compile-time guarantee for a runtime `undefined`). `503` is reached when the machine-node
 * roster cannot be read, which fails closed rather than serving a possibly-revoked node, and is
 * also this listener's answer if the handshake throws for any other reason.
 */
const MACHINE_REJECT_REASON: Record<MachineSubscribeRefusalStatus, string> = {
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
}

/**
 * What a Node deployment acting as a MOTHERSHIP needs in order to serve the machine-authed
 * inbound event subscription (`GET /internal/events/subscribe/:ws`) — the workspace → account
 * resolver the scope binding is built on.
 *
 * **Absent ⇒ the route is not served at all on this runtime**, and the handshake falls through to
 * the upgrade listener's generic `404`. That differs on purpose from the shared controller (which
 * a Cloudflare mothership reaches), where the same missing capability answers `503` to an
 * authenticated caller: the controller is mounted unconditionally and must distinguish "no such
 * route" from "this facade can't scope you", while here an unwired deployment genuinely has no
 * such WebSocket route. Both agree on the part that matters — an unauthenticated caller learns
 * nothing either way.
 *
 * Note this is supplied only by the real Node facade's `start()`. A mothership-MODE local node is
 * a machine-API CLIENT, not a server: its account store lives upstream and its session secret is
 * its own, so serving the route there would be meaningless.
 */
export interface MachineSubscribeDeps {
  accountOf: AccountOfWorkspace
  /** The machine-node roster's revocation read (SEC-5); a revoked node's subscribe is refused. */
  isRevoked?: (nodeId: string) => Promise<boolean>
}

/**
 * Attach the real-time WebSocket transport to a running Node HTTP server: accept
 * `GET /workspaces/:ws/events` upgrades (authorising the `?ticket=` exactly like the
 * shared EventsController), register each socket into the {@link NodeRealtimeHub}, and
 * run a heartbeat that terminates dead connections. Returns a stop function that clears
 * the heartbeat and closes the WS server (call it on graceful shutdown).
 *
 * When `machineSubscribe` is supplied it ALSO accepts the mothership-mode machine subscription
 * (`GET /internal/events/subscribe/:ws`), authorised by the shared `authorizeMachineSubscribe`
 * rather than a browser `?ticket=`. Both handshakes land in the same hub room, so a subscribed
 * node receives exactly what a browser on that workspace does — see the initiative doc. The
 * upgrade is handled here (not in the shared `eventsRelayController`) for the same reason the
 * browser stream is: `@hono/node-server` cannot upgrade from a Hono `Response`, so the request
 * never reaches the controller on this runtime.
 */
export function attachRealtime(
  server: UpgradableServer,
  hub: NodeRealtimeHub,
  auth: AuthConfig,
  log: Logger,
  machineSubscribe?: MachineSubscribeDeps,
): () => void {
  const wss = new WebSocketServer({ noServer: true })

  /** Complete an authorised handshake: join the hub room and hand the socket to the heartbeat. */
  const accept = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    workspaceId: string,
    cid: string | null,
  ) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      hub.subscribe(workspaceId, ws, cid)
      wss.emit('connection', ws, request)
    })
  }

  /** Reject a handshake with a bare status line (there is no Response object at this layer). */
  const reject = (socket: Duplex, status: number, reason: string) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`)
    socket.destroy()
  }

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    // The tab's stable connection id (see the SPA's `utils/connectionId.ts`) — or, on the machine
    // route, the subscribing NODE's stable id — so the hub can skip echoing a mutation back to the
    // connection that caused it.
    const cid = url.searchParams.get('cid')

    // Mothership-mode inbound subscription. Checked before the browser route because the two
    // patterns are disjoint; a deployment that isn't a mothership simply never matches (the
    // request falls through to the 404 below).
    const machineMatch = machineSubscribe
      ? MACHINE_EVENTS_SUBSCRIBE_PATTERN.exec(url.pathname)
      : null
    if (machineMatch && machineSubscribe) {
      const workspaceId = decodeURIComponent(machineMatch[1]!)
      void authorizeMachineSubscribe({
        auth,
        token: request.headers.authorization,
        workspaceId,
        accountOf: machineSubscribe.accountOf,
        isRevoked: machineSubscribe.isRevoked,
      })
        .then((verdict) => {
          if (!verdict.ok) {
            reject(socket, verdict.status, MACHINE_REJECT_REASON[verdict.status])
            return
          }
          accept(request, socket, head, workspaceId, cid)
        })
        // An upgrade has no error handler above it: an unhandled rejection here takes the
        // whole process down (Node's default) and leaves the socket hanging open, so the
        // handshake must settle every path itself. `authorizeMachineSubscribe` already
        // converts a roster read failure into a 503 verdict; this is the backstop for
        // anything a future input adds.
        .catch((error: unknown) => {
          logger.error('machine event subscribe: handshake failed', {
            workspaceId,
            err: describeError(error),
          })
          reject(socket, 503, MACHINE_REJECT_REASON[503])
        })
      return
    }

    const match = WS_EVENTS_PATH.exec(url.pathname)
    // Not our route: refuse rather than leave the socket dangling. (Node mode has no
    // other WebSocket endpoints.)
    if (!match) {
      reject(socket, 404, 'Not Found')
      return
    }
    const workspaceId = decodeURIComponent(match[1]!)
    const ticket = url.searchParams.get('ticket') ?? undefined

    void authorizeWsUpgrade(auth, ticket, workspaceId).then((verdict) => {
      if (!verdict.ok) {
        reject(
          socket,
          verdict.status,
          verdict.status === 401 ? 'Unauthorized' : 'Service Unavailable',
        )
        return
      }
      accept(request, socket, head, workspaceId, cid)
    })
  })

  // Liveness sweep: a socket that doesn't answer a ping before the next tick is
  // half-open (the close event never fired) — terminate it so the room doesn't leak.
  const alive = new WeakSet<WebSocket>()
  wss.on('connection', (ws) => {
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))
  })
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      try {
        ws.ping()
      } catch {
        ws.terminate()
      }
    }
  }, HEARTBEAT_INTERVAL_MS)
  // Don't let the heartbeat timer keep the process alive on shutdown.
  heartbeat.unref?.()

  log.info('real-time WebSocket transport attached (/workspaces/:ws/events)', {})

  return () => {
    clearInterval(heartbeat)
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  }
}
