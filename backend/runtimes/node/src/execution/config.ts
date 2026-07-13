import { type AppConfig, parseNumericEnv } from '@cat-factory/server'
import type { DriveConfig } from './drive.js'
import type { AdvanceQueueOptions, SweeperConfig } from './pgBossRunner.js'

// Translate the runtime-neutral `AppConfig.execution` (durations as strings) into the
// concrete millisecond/second values the pg-boss driver, queue and sweeper need. Shared
// by the container (which builds the work runner) and `start()` (which builds the worker
// + sweeper) so the timing is derived once and stays consistent.

/** Parse a Workflows-style duration ("15 seconds", "5 minutes", "24 hours", "1 day") to ms. */
function durationMs(value: string, fallback: number): number {
  const m = /^(\d+)\s*(second|minute|hour|day)s?$/.exec(value.trim())
  if (!m) return fallback
  const n = Number(m[1])
  const scale =
    m[2] === 'second' ? 1000 : m[2] === 'minute' ? 60_000 : m[2] === 'hour' ? 3_600_000 : 86_400_000
  return n * scale
}

export interface ExecutionRuntime {
  drive: DriveConfig
  queue: AdvanceQueueOptions
  sweeper: SweeperConfig
  /** How many runs the pg-boss worker drives in parallel on this node. */
  concurrency: number
}

/**
 * Derive the driver/queue/sweeper timings from config + env.
 *
 * Liveness is split across two pg-boss mechanisms so neither has to compromise:
 *
 * - `queue.expireInSeconds` is an ABSOLUTE cap on a single advance job (pg-boss times a
 *   job out at `started_on + expireInSeconds` — heartbeats do NOT refresh it). One drive
 *   runs the whole pipeline to a standstill, which can chain MANY container-job polls
 *   (each agent step, plus up to a task's CI-fixer attempts) and CI polls. We therefore
 *   size it to one poll budget (job + CI) times `EXECUTION_MAX_DRIVE_STEPS` (default 16,
 *   covering the standard agent steps plus a CI-fixer retry loop), floored at 1h and
 *   clamped to pg-boss's hard 24h ceiling, so a HEALTHY drive is realistically never
 *   force-failed — which under worker concurrency would let a second worker pick up the
 *   retry and double-drive the same run. `EXECUTION_DRIVE_EXPIRE_MINUTES` overrides the
 *   computed value outright (still clamped to 24h).
 * - `queue.heartbeatSeconds` gives FAST crash recovery independent of that large cap: a
 *   live worker auto-heartbeats its active job, so a crashed/evicted worker stops within
 *   `heartbeatSeconds` (default 60), pg-boss fails the job, frees its singletonKey and the
 *   retry re-drives — no waiting out the multi-hour expire. The stale-run sweeper remains
 *   a last-resort backstop for runs `running` in storage with no live job at all.
 */
export function executionRuntime(config: AppConfig, env: NodeJS.ProcessEnv): ExecutionRuntime {
  const exec = config.execution
  const jobPollIntervalMs = durationMs(exec.jobPollInterval, 15_000)
  const ciPollIntervalMs = durationMs(exec.ciPollInterval, 30_000)

  const drive: DriveConfig = {
    jobPollIntervalMs,
    jobMaxPolls: exec.jobMaxPolls,
    jobPollFailureTolerance: exec.jobPollFailureTolerance,
    ciPollIntervalMs,
    ciMaxPolls: exec.ciMaxPolls,
  }

  // One step's worst-case poll budget (a container-job poll loop + a CI poll loop)...
  const singleStepBudgetMs =
    jobPollIntervalMs * exec.jobMaxPolls + ciPollIntervalMs * exec.ciMaxPolls
  // ...times the most steps a single drive can chain (agent steps + CI-fixer retries).
  const maxDriveSteps = Math.max(
    1,
    num('EXECUTION_MAX_DRIVE_STEPS', env.EXECUTION_MAX_DRIVE_STEPS) ?? 16,
  )
  const maxDriveMs = singleStepBudgetMs * maxDriveSteps
  // Treat an unset OR blank override as "not provided" (a blank env var must not collapse
  // to 0 and force the 60-minute floor over the computed budget); only a real number wins.
  const expireRaw = env.EXECUTION_DRIVE_EXPIRE_MINUTES?.trim()
  const expireMinOverride = expireRaw ? Number(expireRaw) : Number.NaN
  const expireComputed = Number.isFinite(expireMinOverride)
    ? Math.max(60, Math.floor(expireMinOverride)) * 60
    : Math.ceil(Math.max(maxDriveMs, 3_600_000) / 1000)
  // pg-boss hard-caps expireInSeconds at just under 24h. With the default poll budgets the
  // theoretical all-steps-time-out worst case exceeds that — which is fine: heartbeat (not
  // expiry) is the crash detector, and a drive that truly overruns the cap is expired then
  // re-driven idempotently (advanceInstance reads current state; container jobs are polled
  // by id). So clamp to the ceiling and treat expiry as a backstop, not the primary lever.
  const PG_BOSS_MAX_EXPIRE_SECONDS = 24 * 60 * 60 - 1
  const expireInSeconds = Math.min(PG_BOSS_MAX_EXPIRE_SECONDS, expireComputed)

  const queue: AdvanceQueueOptions = {
    expireInSeconds,
    heartbeatSeconds: Math.max(
      10,
      Math.floor(num('EXECUTION_HEARTBEAT_SECONDS', env.EXECUTION_HEARTBEAT_SECONDS) ?? 60),
    ),
    retryLimit: 5,
    retryDelaySeconds: 30,
  }

  const sweeper: SweeperConfig = {
    intervalMs: Math.max(1, Number(env.STALE_RUN_SWEEP_MINUTES) || 5) * 60_000,
    leaseMs: Math.max(1, Number(env.STALE_RUN_LEASE_MINUTES) || 10) * 60_000,
    // A run orphaned this long (no live driver) is failed `stalled` instead of re-driven
    // forever. Generous by default so only genuinely unrecoverable runs are given up on.
    hardStallMs: Math.max(1, Number(env.STALE_RUN_HARD_FAIL_MINUTES) || 60) * 60_000,
  }

  const concurrency = Math.max(1, num('EXECUTION_CONCURRENCY', env.EXECUTION_CONCURRENCY) ?? 10)

  return { drive, queue, sweeper, concurrency }
}

// Parse a numeric env var, warning when a present value is un-parseable rather than
// silently coercing garbage to the caller's default (error-message coverage A8).
const num = parseNumericEnv
