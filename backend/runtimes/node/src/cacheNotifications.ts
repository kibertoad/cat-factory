import type { GroupCacheNotifications, GroupNotificationPairFactory } from '@cat-factory/caching'
import { missingIoredisProblem } from '@cat-factory/server'
import type { PropagatorLogger } from './propagator.js'

// The Redis-backed cache-invalidation notification wiring (caching initiative,
// docs/initiatives/caching-layer.md). Mirrors `redisPropagator.ts`: gated on
// `REDIS_URL` (multi-node deployments only — local mode and single replicas never
// set it), dedicated publisher + subscriber connections per cache channel (a
// subscribed connection can't issue commands, and layered-loader quits a pair's
// clients when its loader closes), error handlers attached at construction, and
// both `ioredis` and layered-loader's Redis modules loaded dynamically so nothing
// Redis-related enters the module graph until an operator opts in.
//
// Redis here is an INVALIDATION BUS, never a data tier: layered-loader publishes
// only keys/groups on `cat-factory:cache:<cacheName>` (prefix overridable via
// `REDIS_CACHE_CHANNEL_PREFIX`); every replica repopulates from its own database.

/** The default channel prefix; each cache gets `<prefix>:<cacheName>`. */
export const DEFAULT_CACHE_CHANNEL_PREFIX = 'cat-factory:cache'

/** Which of the two connections a pair opens — they get different resilience options. */
type CacheRedisRole = 'publisher' | 'subscriber'

/** The slice of the ioredis surface layered-loader's notification classes use. */
export interface CacheRedisClient {
  /** layered-loader's factory distinguishes a live client from options by this field. */
  status: string
  publish(channel: string, message: string): Promise<number>
  subscribe(channel: string): Promise<unknown>
  unsubscribe(channel: string): Promise<unknown>
  on(event: string, listener: (...args: never[]) => void): void
  removeListener(event: string, listener: (...args: never[]) => void): void
  quit(callback?: (err: Error | null | undefined, result: unknown) => void): Promise<unknown>
  disconnect(): void
}

/**
 * Per-role ioredis options, mirroring the realtime propagator: the PUBLISHER
 * fails fast instead of buffering invalidations without bound during an outage
 * (a dropped invalidation degrades to the cache-TTL freshness backstop), while
 * the SUBSCRIBER keeps its offline queue so the initial `subscribe` survives a
 * not-yet-reachable bus (ioredis auto-resubscribes across reconnects).
 */
const CLIENT_OPTIONS: Record<CacheRedisRole, Record<string, unknown>> = {
  publisher: { enableOfflineQueue: false, maxRetriesPerRequest: 0 },
  subscriber: { enableOfflineQueue: true, maxRetriesPerRequest: null },
}

type RedisConstructor = new (url: string, options?: unknown) => CacheRedisClient

async function loadRedis(): Promise<RedisConstructor> {
  try {
    // Opaque specifier on purpose — keeps ioredis out of the TS build graph so the
    // facade compiles and ships without it (it is an optionalDependency).
    const mod = (await import('ioredis' as string)) as {
      default?: RedisConstructor
    } & RedisConstructor
    return (mod.default ?? mod) as RedisConstructor
  } catch (err) {
    // A ConfigValidationError (not a bare Error) so this reaches the misconfigured fallback screen
    // at boot with the install-or-unset remedy, instead of dying opaquely during boot.
    throw missingIoredisProblem('distributed cache invalidation', err)
  }
}

/** layered-loader's group notification factory, loaded only when the bus is on. */
type CreateGroupNotificationPair = <T>(config: {
  channel: string
  publisherRedis: unknown
  consumerRedis: unknown
}) => GroupCacheNotifications<T>

async function loadNotificationFactory(): Promise<CreateGroupNotificationPair> {
  // Loaded dynamically for the same reason as ioredis: layered-loader's root index
  // imports its Redis modules (and thereby ioredis) at module scope, which is why
  // @cat-factory/caching itself only deep-imports the in-memory machinery. The
  // opaque specifier keeps this out of the TS build graph too.
  const mod = (await import('layered-loader' as string)) as {
    createGroupNotificationPair: CreateGroupNotificationPair
  }
  return mod.createGroupNotificationPair
}

export interface CacheNotificationsOptions {
  /**
   * Open a Redis client for the given role. Defaults to constructing an `ioredis`
   * client from `REDIS_URL` with role-specific resilience options and an error
   * handler attached synchronously with construction — before any I/O tick — so an
   * immediate connection failure (ECONNREFUSED / DNS) can never surface as an
   * unhandled 'error' event and crash the process; ioredis connects in the
   * background. A test injects fakes sharing an in-memory bus, so the real
   * layered-loader notification classes run without a live Redis.
   */
  connect?: (url: string, role: CacheRedisRole) => CacheRedisClient
}

/**
 * Build the cache-invalidation notification factory from the environment.
 * Returns `undefined` when `REDIS_URL` is unset — the default for local mode and
 * single-replica Node, where bare in-memory caches are the correct configuration,
 * not a degraded one. When set, returns the `notificationPairFactory` for
 * `createAppCaches`: each named cache gets its own channel and its own dedicated
 * publisher/subscriber client pair, quit by the cache bag's `close()`.
 */
export async function buildCacheNotifications(
  env: NodeJS.ProcessEnv,
  log: PropagatorLogger,
  options: CacheNotificationsOptions = {},
): Promise<GroupNotificationPairFactory | undefined> {
  const redisUrl = env.REDIS_URL?.trim()
  if (!redisUrl) return undefined

  const prefix = env.REDIS_CACHE_CHANNEL_PREFIX?.trim() || DEFAULT_CACHE_CHANNEL_PREFIX
  const createGroupNotificationPair = await loadNotificationFactory()
  const connect =
    options.connect ??
    (await (async () => {
      const Redis = await loadRedis()
      return (url: string, role: CacheRedisRole): CacheRedisClient => {
        const client = new Redis(url, CLIENT_OPTIONS[role])
        client.on('error', (err: unknown) =>
          log.warn(
            { role, err: err instanceof Error ? err.message : String(err) },
            'cache redis connection error (ioredis will retry)',
          ),
        )
        return client
      }
    })())

  return <T>(cacheName: string): GroupCacheNotifications<T> => {
    const channel = `${prefix}:${cacheName}`
    log.info({ channel }, 'cache: distributed invalidation enabled (redis)')
    return createGroupNotificationPair<T>({
      channel,
      // Two dedicated connections per cache: one publishes, one subscribes (a
      // subscribed connection can't publish), and layered-loader quits both with
      // the owning loader — so no client is shared across caches or with the
      // realtime propagator (separate concern, separate channel).
      publisherRedis: connect(redisUrl, 'publisher'),
      consumerRedis: connect(redisUrl, 'subscriber'),
    })
  }
}
