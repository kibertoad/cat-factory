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

export interface ReadinessCheck {
  ok: boolean
  /** The failure detail when `ok` is false — surfaced in the JSON body for operators, not clients. */
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
  const checks: Record<string, ReadinessCheck> = {}
  try {
    await withTimeout(deps.ping(), deps.timeoutMs ?? 2_000)
    checks.database = { ok: true }
  } catch (err) {
    checks.database = { ok: false, error: message(err) }
  }
  checks.pgBoss = deps.pgBossHealthy() ? { ok: true } : { ok: false, error: 'pg-boss not running' }
  return { ready: checks.database.ok && checks.pgBoss.ok, checks }
}

/** Bind {@link checkReadiness} to a fixed set of probes — the shape `createApp` mounts on `/ready`. */
export function makeReadinessProbe(deps: ReadinessProbeDeps): ReadinessProbe {
  return () => checkReadiness(deps)
}
