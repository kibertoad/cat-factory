import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type {
  Block,
  BootstrapJob,
  BrainstormSession,
  ConsensusSession,
  ClarityReview,
  ExecutionInstance,
  KaizenGrading,
  LlmCallActivity,
  Notification,
  RequirementReview,
  WorkspaceEvent,
} from '@cat-factory/contracts'
import type { ExecutionEventPublisher } from '@cat-factory/kernel'
import { type AuthConfig, authorizeWsUpgrade } from '@cat-factory/server'
import { WebSocket, WebSocketServer } from 'ws'

// The Node service's real-time transport — the analogue of the Worker's per-workspace
// WorkspaceEventsHub Durable Object. The browser SPA opens the SAME raw WebSocket the
// Worker serves (`GET /workspaces/:ws/events?ticket=…`, JSON text frames), so nothing
// on the client changes between runtimes. We use the `ws` library directly rather than
// socket.io (which needs its own client + wire protocol the SPA doesn't speak) or
// `@hono/node-ws` (whose `upgradeWebSocket` middleware can't compose with the shared,
// Response-returning EventsController): `@hono/node-server` doesn't upgrade on its own,
// so we attach a `ws` server to the HTTP server's `upgrade` event in {@link attachRealtime}.

/** The minimal logger shape this module needs (a pino logger satisfies it). */
interface RealtimeLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/** The subset of a Node HTTP/HTTP2 server we attach the upgrade listener to. */
interface UpgradableServer {
  on(
    event: 'upgrade',
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void
}

const WS_EVENTS_PATH = /^\/workspaces\/([^/]+)\/events$/

/**
 * Per-workspace subscriber registry. Every browser subscribed to a workspace's stream
 * converges here, so a published event fans out to all of them. In-memory and
 * single-process: the Node service runs as one process (unlike the Worker's globally
 * addressed Durable Object), which is the right model for the self-hosted / local
 * deployments this facade targets. A multi-replica deployment would need a shared bus
 * (Postgres LISTEN/NOTIFY) in front of this — a follow-up, not needed for local mode.
 */
export class NodeRealtimeHub {
  private readonly rooms = new Map<string, Set<WebSocket>>()

  /** Add a socket to a workspace's room; it is reaped on close/error. */
  subscribe(workspaceId: string, socket: WebSocket): void {
    let room = this.rooms.get(workspaceId)
    if (!room) {
      room = new Set()
      this.rooms.set(workspaceId, room)
    }
    room.add(socket)
    const drop = () => this.unsubscribe(workspaceId, socket)
    socket.on('close', drop)
    socket.on('error', drop)
  }

  private unsubscribe(workspaceId: string, socket: WebSocket): void {
    const room = this.rooms.get(workspaceId)
    if (!room) return
    room.delete(socket)
    if (room.size === 0) this.rooms.delete(workspaceId)
  }

  /** Fan a pre-serialised JSON event out to every socket on a workspace's stream. */
  broadcast(workspaceId: string, payload: string): void {
    const room = this.rooms.get(workspaceId)
    if (!room) return
    for (const socket of room) {
      if (socket.readyState !== WebSocket.OPEN) continue
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
  constructor(private readonly hub: NodeRealtimeHub) {}

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

  async boardChanged(workspaceId: string, reason: string, _blockId?: string | null): Promise<void> {
    this.publish(workspaceId, { type: 'board', reason, at: Date.now() })
  }

  async bootstrapChanged(
    workspaceId: string,
    job: BootstrapJob,
    block?: Block | null,
  ): Promise<void> {
    this.publish(workspaceId, { type: 'bootstrap', job, block: block ?? null, at: Date.now() })
  }

  async notificationChanged(workspaceId: string, notification: Notification): Promise<void> {
    this.publish(workspaceId, { type: 'notification', notification, at: Date.now() })
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

  private publish(workspaceId: string, event: WorkspaceEvent): void {
    try {
      this.hub.broadcast(workspaceId, JSON.stringify(event))
    } catch {
      // No subscribers / serialisation hiccup — the DB write is authoritative and the
      // client's reconnect-resync covers any missed event.
    }
  }
}

/** How often to ping idle sockets to detect (and reap) half-open connections. */
const HEARTBEAT_INTERVAL_MS = 30_000

/**
 * Attach the real-time WebSocket transport to a running Node HTTP server: accept
 * `GET /workspaces/:ws/events` upgrades (authorising the `?ticket=` exactly like the
 * shared EventsController), register each socket into the {@link NodeRealtimeHub}, and
 * run a heartbeat that terminates dead connections. Returns a stop function that clears
 * the heartbeat and closes the WS server (call it on graceful shutdown).
 */
export function attachRealtime(
  server: UpgradableServer,
  hub: NodeRealtimeHub,
  auth: AuthConfig,
  log: RealtimeLogger,
): () => void {
  const wss = new WebSocketServer({ noServer: true })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const match = WS_EVENTS_PATH.exec(url.pathname)
    // Not our route: refuse rather than leave the socket dangling. (Node mode has no
    // other WebSocket endpoints.)
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const workspaceId = decodeURIComponent(match[1]!)
    const ticket = url.searchParams.get('ticket') ?? undefined

    void authorizeWsUpgrade(auth, ticket, workspaceId).then((verdict) => {
      if (!verdict.ok) {
        const reason = verdict.status === 401 ? 'Unauthorized' : 'Service Unavailable'
        socket.write(`HTTP/1.1 ${verdict.status} ${reason}\r\n\r\n`)
        socket.destroy()
        return
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        hub.subscribe(workspaceId, ws)
        wss.emit('connection', ws, request)
      })
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

  log.info({}, 'real-time WebSocket transport attached (/workspaces/:ws/events)')

  return () => {
    clearInterval(heartbeat)
    for (const ws of wss.clients) ws.terminate()
    wss.close()
  }
}
