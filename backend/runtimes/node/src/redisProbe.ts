import { DOCS } from '@cat-factory/server'
import type { PropagatorLogger } from './propagator.js'

// Boot-time reachability probe for the optional Redis bus (error-message coverage A7).
//
// When `REDIS_URL` is set but the bus is UNREACHABLE at boot, both Redis consumers — the
// cross-node real-time propagator (`redisPropagator.ts`) and the distributed cache-invalidation
// wiring (`cacheNotifications.ts`) — deliberately do NOT wedge boot: ioredis retries the
// connection in the BACKGROUND (see `RedisWebSocketPropagator.start`, which fires the subscribe
// without awaiting it). That resilience has a downside: with the bus down, cross-node realtime
// and cache coherence are SILENTLY degraded (each replica serves only its own events/caches) and
// nothing tells the operator. This one bounded, best-effort probe surfaces that at boot — naming
// the host and how to verify — instead of leaving it to be discovered from stale peers.
//
// It mirrors local mode's `probeGitHubPat` (A12): best-effort, timeout-bounded, and it NEVER
// blocks or crashes boot — an unreachable bus is a WARNING, not a fatal error (the retry loop is
// the real recovery path). The complementary FATAL case — `REDIS_URL` set but `ioredis` not
// installed — is handled separately by `missingIoredisProblem` (a ConfigValidationError that lands
// on the misconfigured screen), so the probe treats an absent ioredis as "couldn't probe".

/** How long the boot probe waits for the bus to answer before warning. */
export const DEFAULT_REDIS_PROBE_TIMEOUT_MS = 3000

/** The minimal ioredis surface the default probe drives (a one-shot lazy connect). */
interface ProbeRedisClient {
  connect(): Promise<unknown>
  disconnect(): void
  on(event: 'error', listener: (err: unknown) => void): void
}

type ProbeRedisConstructor = new (url: string, options?: unknown) => ProbeRedisClient

/**
 * Result of a single {@link probeRedisReachable} attempt:
 *  - `true`  — the bus answered.
 *  - `false` — the bus did not answer within the timeout (unreachable / DNS / auth rejected).
 *  - `undefined` — the probe couldn't run (ioredis absent). The missing-dependency
 *    {@link missingIoredisProblem} already covers that case fatally, so the probe stays silent.
 */
export type RedisProbeResult = boolean | undefined

/** A pluggable connect probe (default {@link ioredisConnectProbe}); a test injects a fake. */
export type RedisConnectProbe = (url: string, timeoutMs: number) => Promise<RedisProbeResult>

/**
 * A human-readable, CREDENTIAL-FREE label for a `redis://` URL: `host:port` (or just the host).
 * `URL.hostname`/`.port` omit any `user:password@` userinfo, so this is safe to log — a redis URL
 * commonly carries a password (`redis://:secret@host:6379`), which must never reach the logs.
 */
export function redisTargetLabel(url: string): string {
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return 'the configured Redis host'
  }
}

/** The boot warning shown when the Redis bus is set but unreachable. */
export function describeRedisUnreachable(url: string, timeoutMs: number): string {
  const target = redisTargetLabel(url)
  return (
    `REDIS_URL is set but the Redis bus at ${target} did not answer within ${timeoutMs}ms — ` +
    `cross-node real-time propagation and distributed cache invalidation are DEGRADED: each ` +
    `replica serves only its own WebSocket events and caches, so a change on one node won't reach ` +
    `browsers or caches on the others. ioredis keeps retrying in the background, so this ` +
    `self-heals once the bus is reachable. Check that Redis is running and reachable from this ` +
    `node and that REDIS_URL points at it (verify with \`redis-cli -u <REDIS_URL> ping\`). A ` +
    `single-replica or local deployment does not need Redis — unset REDIS_URL to silence this. ` +
    `See ${DOCS.concurrencyAndRedis()}.`
  )
}

/**
 * The default probe: a one-shot, non-retrying lazy connect via `ioredis` (dynamically imported
 * with the same opaque specifier the consumers use, so ioredis stays out of the TS build graph).
 * Bounded by `connectTimeout` + a null retry strategy so it resolves promptly whether the bus is up
 * or down; its own 'error' handler swallows a failed connect so it can't surface as an unhandled
 * event and crash boot. Returns `undefined` when ioredis is absent (the fatal configProblem covers
 * that), `false` on a connect failure, `true` when the bus answered.
 */
async function ioredisConnectProbe(url: string, timeoutMs: number): Promise<RedisProbeResult> {
  let Ctor: ProbeRedisConstructor
  try {
    const mod = (await import('ioredis' as string)) as {
      default?: ProbeRedisConstructor
    } & ProbeRedisConstructor
    Ctor = (mod.default ?? mod) as ProbeRedisConstructor
  } catch {
    return undefined
  }
  const client = new Ctor(url, {
    lazyConnect: true,
    connectTimeout: timeoutMs,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  })
  client.on('error', () => {})
  try {
    await client.connect()
    return true
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}

/**
 * Best-effort reachability check of the Redis bus at `url`. Never throws and is bounded by a hard
 * timeout guard (in case an injected/real probe hangs), so it is always safe to await at boot.
 * `connectProbe` + `timeoutMs` are injectable for tests.
 */
export async function probeRedisReachable(
  url: string,
  opts: { connectProbe?: RedisConnectProbe; timeoutMs?: number } = {},
): Promise<RedisProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REDIS_PROBE_TIMEOUT_MS
  const probe = opts.connectProbe ?? ioredisConnectProbe
  let guard: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<RedisProbeResult>([
      probe(url, timeoutMs),
      // Belt-and-suspenders: if the probe itself hangs past its own deadline, treat the bus as
      // unreachable rather than waiting indefinitely (the default probe won't, but an env quirk
      // could). A little slack over timeoutMs lets the probe's own timeout win the race normally.
      new Promise<RedisProbeResult>((resolve) => {
        guard = setTimeout(() => resolve(false), timeoutMs + 500)
      }),
    ])
  } catch {
    return false
  } finally {
    if (guard) clearTimeout(guard)
  }
}

/**
 * Probe the Redis bus at boot and, when it is set but unreachable, log ONE elaborate warning
 * naming the host + how to verify. A no-op when `REDIS_URL` is unset (single-node / local) or when
 * the probe couldn't run (ioredis absent — the fatal {@link missingIoredisProblem} covers that).
 */
export async function warnIfRedisUnreachable(
  env: NodeJS.ProcessEnv,
  log: PropagatorLogger,
  opts: { connectProbe?: RedisConnectProbe; timeoutMs?: number } = {},
): Promise<void> {
  const url = env.REDIS_URL?.trim()
  if (!url) return
  const reachable = await probeRedisReachable(url, opts)
  if (reachable === false) {
    log.warn(
      { target: redisTargetLabel(url) },
      describeRedisUnreachable(url, opts.timeoutMs ?? DEFAULT_REDIS_PROBE_TIMEOUT_MS),
    )
  }
}

/**
 * Fire {@link warnIfRedisUnreachable} WITHOUT blocking the caller (app-startup initiative, item 5).
 * Returns immediately; the warning (if any) fires when the bounded probe later resolves. The probe
 * is diagnostics-only — ioredis retries the bus in the background regardless — so a set-but-down
 * bus must NOT hold the boot path for the probe's full timeout. Mirrors the blessed
 * `preflightHarnessImage` fire-and-forget shape (`void probe().catch(() => {})`); never throws
 * (`warnIfRedisUnreachable` already swallows probe failures, the `.catch` is belt-and-suspenders).
 */
export function warnIfRedisUnreachableInBackground(
  env: NodeJS.ProcessEnv,
  log: PropagatorLogger,
  opts: { connectProbe?: RedisConnectProbe; timeoutMs?: number } = {},
): void {
  void warnIfRedisUnreachable(env, log, opts).catch(() => {})
}
