import type { InfraReachabilityConfig } from './types.js'
import { parseNumericEnv } from './numeric.js'

// Shared, runtime-neutral parser for the infrastructure-reachability watcher env, so the Worker's
// `loadConfig` and the Node/local `loadNodeConfig` derive an IDENTICAL `InfraReachabilityConfig`
// from the same vars + defaults + clamps ("keep the runtimes symmetric"). Each facade reads its own
// env source (Cloudflare `Env` vs `process.env`) into the raw-string bag below and calls this — the
// parsing/clamping lives in exactly one place. Mirrors `platformAlerts.ts`.

/** How often the Node sweep runs when `INFRA_REACHABILITY_INTERVAL_MS` is unset (5 minutes). */
const DEFAULT_INTERVAL_MS = 5 * 60_000
/** Floor the interval so a `0`/tiny override can't turn the sweep into an outbound busy-loop. */
const MIN_INTERVAL_MS = 30_000
/** Per-probe timeout when `INFRA_REACHABILITY_PROBE_TIMEOUT_MS` is unset. */
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
/**
 * Floor the per-probe timeout. A sub-second budget would report every healthy-but-distant
 * apiserver as an outage, which is worse than not watching at all.
 */
const MIN_PROBE_TIMEOUT_MS = 1_000
/**
 * Ceiling the per-probe timeout at the Worker's cron cadence: a budget longer than the gap between
 * passes lets one hung connection keep a pass in flight when the next is already due.
 */
const MAX_PROBE_TIMEOUT_MS = 60_000

/**
 * Whether a CRON-driven facade should run the sweep on this tick, so `INFRA_REACHABILITY_INTERVAL_MS`
 * means the same thing on the Worker as the timer gives it on Node.
 *
 * The Worker's `scheduled` tick fires every 2 minutes for every backstop it drives, and this sweep
 * used to run on all of them — so the one knob an operator has for the one sweep that makes an
 * outbound call per workspace per pass did nothing on Cloudflare, and opting in bought a fixed
 * 2-minute probe cadence. Since a cron tick runs in a fresh isolate there is no "last pass" in
 * memory, and the whole design point is that this feature adds no persistence; so the gate is pure
 * ARITHMETIC on the cron's own aligned timestamp: run only on the tick that opens a new
 * `intervalMs` window. That yields at most one pass per window with no state at all, and is exact
 * (not merely probabilistic) because `scheduledTime` is cron-aligned.
 *
 * An interval at or below the tick period means "every tick", which is what a Node deployment with
 * the same setting gets.
 */
export function shouldRunReachabilityPass(
  scheduledTime: number,
  tickPeriodMs: number,
  intervalMs: number,
): boolean {
  if (intervalMs <= tickPeriodMs) return true
  return (
    Math.floor(scheduledTime / intervalMs) !==
    Math.floor((scheduledTime - tickPeriodMs) / intervalMs)
  )
}

/** The raw env strings each facade feeds the parser (already extracted from its env source). */
export interface InfraReachabilityEnvInput {
  /** Whether `INFRA_REACHABILITY_WATCH` opted the watcher in. */
  enabled: boolean
  intervalMs?: string
  probeTimeoutMs?: string
}

/**
 * Resolve the reachability-watcher config from raw env strings. Unset/blank/garbage values fall
 * back to the defaults (a non-numeric value emits the shared `parseNumericEnv` warning); negatives
 * are treated as unset. Both durations are clamped, so a hostile/typo'd override degrades to a
 * sane sweep rather than a busy-loop or a watcher that calls everything down.
 */
export function resolveInfraReachabilityConfig(
  env: InfraReachabilityEnvInput,
): InfraReachabilityConfig {
  const nonNeg = (name: string, raw: string | undefined, fallback: number): number => {
    const n = parseNumericEnv(name, raw)
    return n !== undefined && n >= 0 ? n : fallback
  }
  return {
    enabled: env.enabled,
    intervalMs: Math.max(
      MIN_INTERVAL_MS,
      nonNeg('INFRA_REACHABILITY_INTERVAL_MS', env.intervalMs, DEFAULT_INTERVAL_MS),
    ),
    probeTimeoutMs: Math.min(
      MAX_PROBE_TIMEOUT_MS,
      Math.max(
        MIN_PROBE_TIMEOUT_MS,
        nonNeg('INFRA_REACHABILITY_PROBE_TIMEOUT_MS', env.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
      ),
    ),
  }
}
