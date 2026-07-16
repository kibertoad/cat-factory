import type { LocalEventSink, NodeRealtimeHub } from './realtime.js'
import { RedisWebSocketPropagator } from './redisPropagator.js'

// Cross-node real-time propagation.
//
// The Node facade's {@link NodeRealtimeHub} is a single-process, in-memory socket registry:
// an event published on the node that processed a run only reaches browsers connected to
// THAT node. That's exactly right for local mode (one process) and for a single Node
// replica. A horizontally-scaled deployment, though, spreads browsers and background work
// across several nodes, so an event produced on node B must also reach a browser attached
// to node A.
//
// This module adds that reach as a LAYERED propagator with pluggable adapters. Publishing an
// event fans it to the local hub AND to every configured cross-node adapter; an adapter
// carries the event to peer nodes, which apply it to their own local hubs. Redis pub/sub is
// the first adapter ({@link RedisWebSocketPropagator}); a Postgres LISTEN/NOTIFY or NATS
// adapter would implement the same {@link WebSocketPropagator} port with no other changes.
//
// With no adapters (the default — local mode, single replica) the layer is exactly the bare
// hub with zero overhead and no extra dependency, so this is safe to wire unconditionally.
//
// Why the Worker facade needs none of this: its real-time transport is a globally-addressed
// `WorkspaceEventsHub` Durable Object — exactly one instance per workspace across the whole
// deployment — so cross-node propagation is inherent to the platform. This is a genuine
// Node-only concern, not a facade-parity gap.

/** The minimal logger shape the propagator + its adapters need (a pino logger satisfies it). */
export interface PropagatorLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
}

/**
 * A pre-serialised workspace event queued for cross-node delivery. `payload` is the exact
 * JSON text frame the SPA receives (produced by {@link NodeEventPublisher}); `originConnectionId`
 * carries the `?cid=` of the tab that caused a board mutation so its own echo can be suppressed
 * (harmless across nodes — a peer simply won't hold that connection).
 */
export interface RealtimeMessage {
  workspaceId: string
  payload: string
  originConnectionId?: string | null
}

/**
 * A cross-node delivery adapter. It PUBLISHES locally-originated events to peer nodes and,
 * once started, APPLIES events arriving from peers to the local hub via the `deliver` callback.
 * Adapters must ignore their OWN echoes (an event this node published coming back over the bus)
 * — the local hub already delivered it — so implementations tag messages with a per-node id.
 */
export interface WebSocketPropagator {
  /** Human-readable adapter name, for logs. */
  readonly name: string
  /**
   * Forward a locally-originated event to peer nodes. Best-effort and non-blocking: a bus
   * hiccup must never break a state transition (the persisted row is the source of truth and
   * clients reconcile on reconnect), so this never throws.
   */
  publish(message: RealtimeMessage): void
  /**
   * Connect and begin receiving peer events; each is handed to `deliver`, which applies it to
   * the local hub. Throws if the adapter cannot be initialised (e.g. an opt-in dependency is
   * missing) — the operator asked for it by configuring it, so fail loud at boot.
   */
  start(deliver: (message: RealtimeMessage) => void): Promise<void>
  /** Release connections on shutdown. */
  stop(): Promise<void>
}

/**
 * The layered real-time sink: every published event fans to the local {@link NodeRealtimeHub}
 * AND to each configured cross-node adapter, and every event arriving from a peer is applied
 * back to the local hub. Implements {@link LocalEventSink}, so it is a drop-in replacement for
 * the bare hub in {@link NodeEventPublisher} — the rest of the engine is oblivious.
 */
export class LayeredEventPropagator implements LocalEventSink {
  constructor(
    // The LOCAL delivery target every published event fans to first. Typed as the {@link LocalEventSink}
    // seam (not the concrete {@link NodeRealtimeHub}) because the layer only ever calls `.broadcast` on
    // it — this is the bare hub in production, and lets a caller (local mothership mode) layer an adapter
    // over an already-injected sink without an unsafe cast.
    private readonly hub: LocalEventSink,
    private readonly adapters: readonly WebSocketPropagator[] = [],
  ) {}

  /** Whether any cross-node adapter is wired (false ⇒ this is just the bare local hub). */
  get hasRemote(): boolean {
    return this.adapters.length > 0
  }

  broadcast(workspaceId: string, payload: string, originConnectionId?: string | null): void {
    // Local sockets first — the common path and the only one for a single-node deployment.
    this.hub.broadcast(workspaceId, payload, originConnectionId)
    // Then to peer nodes. Adapters swallow their own errors (best-effort), so this loop can't
    // throw and can't be starved by a slow bus.
    for (const adapter of this.adapters) {
      adapter.publish({ workspaceId, payload, originConnectionId })
    }
  }

  /**
   * Start every adapter. A peer event is applied straight to the local hub (NOT back through
   * {@link broadcast}), so it is never re-published to the bus — that both prevents an infinite
   * loop and avoids double delivery.
   */
  async start(log: PropagatorLogger): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.start((message) =>
        this.hub.broadcast(message.workspaceId, message.payload, message.originConnectionId),
      )
      log.info({ adapter: adapter.name }, 'real-time cross-node propagation adapter started')
    }
  }

  async stop(): Promise<void> {
    for (const adapter of this.adapters) {
      await adapter.stop()
    }
  }
}

/**
 * Compose the real-time sink from the environment. Wires a {@link RedisWebSocketPropagator}
 * when `REDIS_URL` is set (multi-node deployment); otherwise returns the bare-hub layer with no
 * adapters and no extra dependency — the default for local mode and single-replica Node, which
 * never set `REDIS_URL`. Configurable via `REDIS_REALTIME_CHANNEL` (the pub/sub channel, default
 * `cat-factory:realtime`) and `REALTIME_NODE_ID` (an optional readable prefix for this node's
 * echo-suppression id — a per-process random suffix is always appended, so it is safe to set the
 * same value on every replica).
 */
export function buildRealtimePropagator(
  hub: NodeRealtimeHub,
  env: NodeJS.ProcessEnv,
  log: PropagatorLogger,
): LayeredEventPropagator {
  const adapters: WebSocketPropagator[] = []
  const redisUrl = env.REDIS_URL?.trim()
  if (redisUrl) {
    const channel = env.REDIS_REALTIME_CHANNEL?.trim() || undefined
    adapters.push(
      new RedisWebSocketPropagator({
        url: redisUrl,
        channel,
        nodeId: env.REALTIME_NODE_ID?.trim() || undefined,
        log,
      }),
    )
    log.info(
      { channel: channel ?? 'cat-factory:realtime' },
      'real-time: cross-node WebSocket propagation enabled (redis)',
    )
  }
  return new LayeredEventPropagator(hub, adapters)
}
