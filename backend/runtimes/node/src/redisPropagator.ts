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

type RedisConstructor = new (url: string) => RedisClient

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
  /** This node's id for echo suppression (default a random uuid). */
  nodeId?: string
  log: PropagatorLogger
  /**
   * Connect a fresh Redis client. Defaults to constructing an `ioredis` client from `url`
   * (dynamically imported). A test injects a fake pair sharing an in-memory bus, so the
   * envelope/echo-suppression logic runs without a live Redis.
   */
  connect?: (url: string) => Promise<RedisClient>
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
  private readonly connect: (url: string) => Promise<RedisClient>
  private pub?: RedisClient
  private sub?: RedisClient

  constructor(options: RedisWebSocketPropagatorOptions) {
    this.url = options.url
    this.channel = options.channel ?? DEFAULT_REALTIME_CHANNEL
    this.nodeId = options.nodeId ?? randomUUID()
    this.log = options.log
    this.connect = options.connect ?? (async (url) => new (await loadRedis())(url))
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
    // reconnect if this drops.
    void this.pub.publish(this.channel, JSON.stringify(envelope)).catch((err) => {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'real-time redis publish failed (event delivered locally; peers reconcile on reconnect)',
      )
    })
  }

  async start(deliver: (message: RealtimeMessage) => void): Promise<void> {
    // Two connections: one publishes, one subscribes (a subscribed connection can't publish).
    this.pub = await this.connect(this.url)
    this.sub = await this.connect(this.url)
    // Keep the process alive on a broken bus rather than crashing: log and let ioredis retry.
    this.pub.on('error', (err) => this.onConnectionError('publisher', err))
    this.sub.on('error', (err) => this.onConnectionError('subscriber', err))
    this.sub.on('message', (channel, raw) => {
      if (channel !== this.channel) return
      const envelope = this.parse(raw)
      // Drop malformed frames and our OWN echoes — the local hub already delivered those.
      if (!envelope || envelope.n === this.nodeId) return
      deliver({ workspaceId: envelope.w, payload: envelope.p, originConnectionId: envelope.c })
    })
    await this.sub.subscribe(this.channel)
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
