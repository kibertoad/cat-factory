import type { PlatformObservabilityWindow } from '@cat-factory/contracts'
import { DEFAULT_PLATFORM_ALERT_THRESHOLDS } from '@cat-factory/orchestration'
import type { PlatformAlertConfig } from './types.js'
import { parseNumericEnv } from './numeric.js'

// Shared, runtime-neutral parser for the platform-health alerting env, so the Worker's
// `loadConfig` and the Node/local `loadNodeConfig` derive an IDENTICAL `PlatformAlertConfig`
// from the same vars + defaults + clamps ("keep the runtimes symmetric"). Each facade reads
// its own env source (Cloudflare `Env` vs `process.env`) into the raw-string bag below and
// calls this — the parsing/clamping lives in exactly one place.

/** How often the Node sweep runs when `PLATFORM_ALERTS_INTERVAL_MS` is unset (5 minutes). */
const DEFAULT_PLATFORM_ALERT_INTERVAL_MS = 5 * 60_000
/** Floor the interval so a `0`/tiny override can't turn the sweep into a busy-loop. */
const MIN_PLATFORM_ALERT_INTERVAL_MS = 10_000

/** Parse the `1h`/`24h`/`7d` window, defaulting to the most operationally useful `1h`. */
export function parsePlatformObservabilityWindow(
  raw: string | undefined,
): PlatformObservabilityWindow {
  const v = raw?.trim()
  return v === '24h' || v === '7d' ? v : '1h'
}

/** The raw env strings each facade feeds the parser (already extracted from its env source). */
export interface PlatformAlertEnvInput {
  /** Whether `PLATFORM_ALERTS` opted the sweep in. */
  enabled: boolean
  window?: string
  intervalMs?: string
  minRuns?: string
  maxFailureRate?: string
  maxP99Minutes?: string
  maxBacklog?: string
}

/**
 * Resolve the platform-health alert config from raw env strings. Unset/blank/garbage values
 * fall back to {@link DEFAULT_PLATFORM_ALERT_THRESHOLDS} (a non-numeric value emits the shared
 * `parseNumericEnv` warning); negatives are treated as unset. The failure-rate ceiling is
 * clamped to 0..1, and the interval is floored so it can't busy-loop.
 */
export function resolvePlatformAlertConfig(env: PlatformAlertEnvInput): PlatformAlertConfig {
  const d = DEFAULT_PLATFORM_ALERT_THRESHOLDS
  const nonNeg = (name: string, raw: string | undefined, fallback: number): number => {
    const n = parseNumericEnv(name, raw)
    return n !== undefined && n >= 0 ? n : fallback
  }
  const maxP99Minutes = nonNeg(
    'PLATFORM_ALERTS_MAX_P99_MINUTES',
    env.maxP99Minutes,
    d.maxP99DurationMs / 60_000,
  )
  const failureRate = nonNeg(
    'PLATFORM_ALERTS_MAX_FAILURE_RATE',
    env.maxFailureRate,
    d.maxFailureRate,
  )
  return {
    enabled: env.enabled,
    window: parsePlatformObservabilityWindow(env.window),
    intervalMs: Math.max(
      MIN_PLATFORM_ALERT_INTERVAL_MS,
      nonNeg('PLATFORM_ALERTS_INTERVAL_MS', env.intervalMs, DEFAULT_PLATFORM_ALERT_INTERVAL_MS),
    ),
    thresholds: {
      minRuns: Math.max(1, nonNeg('PLATFORM_ALERTS_MIN_RUNS', env.minRuns, d.minRuns)),
      maxFailureRate: Math.min(1, failureRate),
      maxP99DurationMs: maxP99Minutes * 60_000,
      maxBacklog: Math.max(1, nonNeg('PLATFORM_ALERTS_MAX_BACKLOG', env.maxBacklog, d.maxBacklog)),
    },
  }
}
