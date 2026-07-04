import { randomUUID } from 'node:crypto'
import type { PropagatorLogger, RealtimeMessage, WebSocketPropagator } from './propagator.js'

// The Redis adapter for cross-node real-time propagation (see `propagator.ts`). Modelled on
// the two-connection pub/sub pattern (a dedicated publisher + a dedicated subscriber, since a
// connection in subscriber mode can't issue other commands), with a versioned, node-tagged
// envelope so a node ignores the echoes of events it published itself.
//
// `ioredis` is an OPTIONAL dependency: it is imported dynamically only when a deployment sets
// `REDIS_URL`, so a build/install without it (the local-mode default) is unaffected. The
// specifier is opaque (`'ioredis' as string`) on purpose — that keeps the module out of the
// TypeScript build graph so the facade compiles and ships without ioredis present.

/** The tiny slice of the ioredis client surface this adapter uses. */
export interface RedisClient {
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): void
  on(event: 'error', listener: (err: unknown) => void): void
  quit(): Promise<unknown>
  disconnect(): void
}

/** Which of the two connections we're opening — they get different resilience options. */
type RedisRole = 'publisher' | 'subscriber'

type RedisConstructor = new (url: string, options?: unknown) => RedisClient

async function loadRedis(): Promise<RedisConstructor> {
  try {
    const mod = (await import('ioredis' as string)) as {
      default?: RedisConstructor
    } & RedisConstructor
    // ioredis is a CJS module: the constructor is the default export under ESM interop, but
    // fall back to the namespace itself for older/edge resolutions.
    return (mod.default ?? mod) as RedisConstructor
  } catch (err) {
    throw new Error(
      `REDIS_URL is set but the optional 'ioredis' dependency could not be loaded — install it ` +
        `(pnpm add ioredis) to enable cross-node WebSocket propagation, or unset REDIS_URL to run ` +
        `single-node. Original error: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Per-role ioredis options. The PUBLISHER fails fast rather than buffering: with
 * `enableOfflineQueue: false` a publish issued while the bus is down rejects immediately
 * (hitting the warn path) instead of piling up in an unbounded offline queue during an outage.
 * The SUBSCRIBER keeps its offline queue so the single `subscribe` command survives the initial
 * connect / a reconnect (ioredis auto-resubscribes), and never gives up retrying it.
 */
const CLIENT_OPTIONS: Record<RedisRole, Record<string, unknown>> = {
  publisher: { enableOfflineQueue: false, maxRetriesPerRequest: 0 },
  subscriber: { enableOfflineQueue: true, maxRetriesPerRequest: null },
}

/** The default Redis pub/sub channel; a single channel carries every workspace's events. */
export const DEFAULT_REALTIME_CHANNEL = 'cat-factory:realtime'

/** Versioned wire envelope. `n` is the origin node id, used to drop our own echoes. */
interface RealtimeEnvelope {
  v: 1
  n: string
  w: string
  p: string
  c?: string | null
}

export interface RedisWebSocketPropagatorOptions {
  url: string
  /** Pub/sub channel (default {@link DEFAULT_REALTIME_CHANNEL}). */
  channel?: string
  /**
   * An optional human-readable prefix for this node's echo-suppression id (for logs /
   * correlation). A per-process random suffix is ALWAYS appended, so the effective id is unique
   * even when every replica is given the same value — see the constructor.
   */
  nodeId?: string
  log: PropagatorLogger
  /**
   * Connect a fresh Redis client for the given role. Defaults to constructing an `ioredis`
   * client from `url` (dynamically imported) with role-specific resilience options and an
   * error handler attached synchronously. A test injects a fake pair sharing an in-memory bus,
   * so the envelope/echo-suppression logic runs without a live Redis.
   */
  connect?: (url: string, role: RedisRole) => Promise<RedisClient>
}

/**
 * Cross-node real-time propagation over Redis pub/sub. A single channel carries every
 * workspace's pre-serialised events; each node subscribes, ignores its own echoes (by node id),
 * and applies peer events to its local hub.
 */
export class RedisWebSocketPropagator implements WebSocketPropagator {
  readonly name = 'redis'
  private readonly url: string
  private readonly channel: string
  private readonly nodeId: string
  private readonly log: PropagatorLogger
  private readonly connect: (url: string, role: RedisRole) => Promise<RedisClient>
  private pub?: RedisClient
  private sub?: RedisClient

  constructor(options: RedisWebSocketPropagatorOptions) {
    this.url = options.url
    this.channel = options.channel ?? DEFAULT_REALTIME_CHANNEL
    // Echo suppression is correct ONLY if this id is unique per process. A random uuid alone
    // guarantees that, but if an operator pins REALTIME_NODE_ID to a fixed value applied across
    // every replica (a common shared-config pattern), all nodes would share an id and each would
    // treat every peer's events as its own echo — silently dropping ALL cross-node propagation.
    // So always append a per-process random suffix; the provided value is only a readable prefix.
    const prefix = options.nodeId?.trim()
    this.nodeId = prefix ? `${prefix}-${randomUUID()}` : randomUUID()
    this.log = options.log
    this.connect = options.connect ?? ((url, role) => this.defaultConnect(url, role))
  }

  private async defaultConnect(url: string, role: RedisRole): Promise<RedisClient> {
    const Redis = await loadRedis()
    const client = new Redis(url, CLIENT_OPTIONS[role])
    // Attach the error handler synchronously with construction — before any I/O tick — so an
    // immediate connection failure (ECONNREFUSED / DNS) can never surface as an unhandled
    // 'error' event, which Node would rethrow and crash the whole process on. ioredis retries
    // the connection in the background; we just log.
    client.on('error', (err) => this.onConnectionError(role, err))
    return client
  }

  publish(message: RealtimeMessage): void {
    if (!this.pub) return
    const envelope: RealtimeEnvelope = {
      v: 1,
      n: this.nodeId,
      w: message.workspaceId,
      p: message.payload,
      ...(message.originConnectionId ? { c: message.originConnectionId } : {}),
    }
    // Fire-and-forget: a publish failure must never break the state transition that produced
    // the event. The local hub already delivered to this node's browsers; peers reconcile on
    // reconnect if this drops. The publisher's offline queue is disabled (see CLIENT_OPTIONS),
    // so a publish while the bus is down rejects here rather than buffering without bound.
    void this.pub.publish(this.channel, JSON.stringify(envelope)).catch((err) => {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'real-time redis publish failed (event delivered locally; peers reconcile on reconnect)',
      )
    })
  }

  async start(deliver: (message: RealtimeMessage) => void): Promise<void> {
    try {
      // Two connections: one publishes, one subscribes (a subscribed connection can't publish).
      // Each opens with its error handler already attached (see defaultConnect).
      this.pub = await this.connect(this.url, 'publisher')
      this.sub = await this.connect(this.url, 'subscriber')
      this.sub.on('message', (channel, raw) => {
        if (channel !== this.channel) return
        const envelope = this.parse(raw)
        // Drop malformed frames and our OWN echoes — the local hub already delivered those.
        if (!envelope || envelope.n === this.nodeId) return
        deliver({ workspaceId: envelope.w, payload: envelope.p, originConnectionId: envelope.c })
      })
      // Do NOT await the subscribe: on an unreachable bus it would sit in the offline queue and
      // never resolve, wedging the whole server boot (the HTTP listener binds after start()).
      // The local hub still delivers; ioredis connects + subscribes in the background and
      // auto-resubscribes across reconnects. A hard failure is logged, not thrown.
      void this.sub
        .subscribe(this.channel)
        .catch((err) => this.onConnectionError('subscriber', err))
    } catch (err) {
      // A client opened before the failure would otherwise leak (its reconnect timer keeps the
      // event loop alive), and shutdown's stop() isn't wired up until after start() returns —
      // so release eagerly here before rethrowing.
      await this.stop()
      throw err
    }
  }

  async stop(): Promise<void> {
    // `quit()` drains in-flight commands; fall back to a hard disconnect if it rejects.
    await Promise.allSettled([this.gracefulClose(this.pub), this.gracefulClose(this.sub)])
    this.pub = undefined
    this.sub = undefined
  }

  private async gracefulClose(client: RedisClient | undefined): Promise<void> {
    if (!client) return
    try {
      await client.quit()
    } catch {
      client.disconnect()
    }
  }

  private onConnectionError(role: string, err: unknown): void {
    this.log.warn(
      { role, err: err instanceof Error ? err.message : String(err) },
      'real-time redis connection error (ioredis will retry)',
    )
  }

  private parse(raw: string): RealtimeEnvelope | undefined {
    try {
      const value = JSON.parse(raw) as RealtimeEnvelope
      if (value && value.v === 1 && typeof value.w === 'string' && typeof value.p === 'string') {
        return value
      }
    } catch {
      // A foreign / corrupt frame on the channel — ignore it.
    }
    return undefined
  }
}
