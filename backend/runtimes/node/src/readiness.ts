// Readiness probing for the Node facade's `/ready` endpoint.
//
// `/health` (in server.ts) is a cheap LIVENESS signal — the process is up and the event loop
// turns. It answers 200 regardless of downstream health, exactly as a liveness probe should:
// a liveness failure means "restart me", and a dead Postgres pool is not fixed by a restart.
//
// `/ready` is the READINESS signal a load balancer / orchestrator drains on: it round-trips the
// app's Postgres pool and confirms pg-boss is running, so a replica whose pool has died or whose
// durable-execution worker has stopped reports NOT ready and is taken out of rotation without
// killing it. It also flips to not-ready the instant graceful shutdown begins, so new traffic
// stops arriving while in-flight requests drain.
//
// This is legitimately Node-facade-specific: the Worker has no long-lived process to probe (each
// request is a fresh isolate), so it has no readiness concept. Local mothership mode has no local
// Postgres/pg-boss either (org state is served remotely), so it wires no probe and `/ready` simply
// mirrors `/health`.
//
// TWO dependencies are deliberately NOT probed here, and both decisions are the point rather
// than an omission:
//
//   - REDIS. Probing it per request would mean either opening a connection each time (worse
//     than the gap it closes) or widening the propagator's adapter seam to expose a client's
//     internal state. And the verdict would be wrong either way: a dead Redis degrades
//     cross-node real-time, which a replica should keep serving HTTP through, not drain on.
//     Its boot probe (`redisProbe.ts`) and the propagator's own per-publish warnings own it.
//   - THE TELEMETRY STORE. On this facade it is a SCHEMA in the same Postgres database, so the
//     `SELECT 1` above already covers reaching it; a second query would test the same
//     connection and report a second, correlated opinion of it. (It is a physically separate
//     D1 database only on Cloudflare, which has no `/ready` at all — see below.)

export interface ReadinessCheck {
  ok: boolean
  /**
   * The failure detail when `ok` is false. `/ready` is PUBLIC (unauthenticated, like `/health`), so
   * this string is readable by any client — keep it to a short diagnostic (`pg-boss not running`,
   * `timed out after 2000ms`) and NEVER put a connection string, host, or credential in it.
   */
  error?: string
}

export interface ReadinessReport {
  ready: boolean
  /** Per-dependency results, keyed by name (`database`, `pgBoss`, or `shutdown` while draining). */
  checks: Record<string, ReadinessCheck>
}

export type ReadinessProbe = () => Promise<ReadinessReport>

export interface ReadinessProbeDeps {
  /** Round-trips the app's Postgres pool (a bare `SELECT 1`) — resolves on success, throws on failure. */
  ping: () => Promise<void>
  /** Whether pg-boss is started and has not emitted `stopped` (a flag the boot sequence owns). */
  pgBossHealthy: () => boolean
  /**
   * Round-trips PG-BOSS's OWN connection (a metadata read through its pool) — resolves on
   * success, throws on failure. The flag above only observes the GRACEFUL `stopped`
   * transition, so a boss whose connection died without emitting it read healthy forever; this
   * is what turns that into a real check, and it probes a pool the app's own `ping` does not
   * touch (pg-boss keeps its own).
   *
   * What it still does NOT prove, stated rather than implied: that the worker LOOP is
   * consuming. A boss whose connection is fine but whose workers have stopped picking up jobs
   * passes this. That failure is visible as unbounded queue depth, which is why slice 4.1's
   * `queue.depth` gauge is the signal for it — draining a replica on it would be wrong anyway,
   * since the replica still serves HTTP perfectly well.
   *
   * Omitted ⇒ only the flag is consulted (an embedded/test wiring with no boss to probe).
   */
  pgBossPing?: () => Promise<void>
  /** True once graceful shutdown has begun, so the probe drains immediately. Optional (default: not draining). */
  isDraining?: () => boolean
  /** Bounds the DB probe so a wedged pool can't hang the health check. Default 2000ms. */
  timeoutMs?: number
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Reject if `promise` hasn't settled within `ms` — a wedged pool must not hang `/ready`. */
async function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    // The probe fires every few seconds; its timeout must never keep the process alive on its own.
    timer.unref?.()
  })
  // When the timeout wins the race, `promise` (a wedged `SELECT 1`) is still pending and may reject
  // LATER — exactly the degraded-pool path this probe exists to detect. Nothing awaits it by then,
  // so attach a no-op handler to swallow that late rejection and avoid an unhandledRejection. This
  // does not hide a pre-timeout failure: the race still observes `promise` rejecting and rejects.
  // silent-catch-ok: the race above already surfaces this rejection when it lands in time; a
  // second report here would warn on every probe timeout for a cause the caller already has.
  promise.catch(() => {})
  try {
    await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Compute the readiness verdict. Draining short-circuits (a SIGTERM'd node reports not-ready
 * immediately so the LB stops routing new traffic while in-flight requests finish — the
 * downstream probes are irrelevant to that decision). Otherwise both the Postgres pool and
 * pg-boss must be healthy for `ready: true`.
 */
export async function checkReadiness(deps: ReadinessProbeDeps): Promise<ReadinessReport> {
  if (deps.isDraining?.()) {
    return { ready: false, checks: { shutdown: { ok: false, error: 'draining' } } }
  }
  const timeoutMs = deps.timeoutMs ?? 2_000
  const probe = async (run: () => Promise<void>): Promise<ReadinessCheck> => {
    try {
      await withTimeout(run(), timeoutMs)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: message(err) }
    }
  }
  const checks: Record<string, ReadinessCheck> = {}
  checks.database = await probe(deps.ping)
  // pg-boss: the graceful-stop flag AND a real round-trip through its own connection. The flag
  // alone was the whole check, and it is only ever flipped by a clean `stopped` — so the one
  // failure a readiness probe exists to catch (the substrate died under a running process)
  // reported healthy. Ordered flag-first because it is free and definitive when it says no.
  checks.pgBoss = !deps.pgBossHealthy()
    ? { ok: false, error: 'pg-boss not running' }
    : deps.pgBossPing
      ? await probe(deps.pgBossPing)
      : { ok: true }
  return { ready: Object.values(checks).every((check) => check.ok), checks }
}

/** Bind {@link checkReadiness} to a fixed set of probes — the shape `createApp` mounts on `/ready`. */
export function makeReadinessProbe(deps: ReadinessProbeDeps): ReadinessProbe {
  return () => checkReadiness(deps)
}
