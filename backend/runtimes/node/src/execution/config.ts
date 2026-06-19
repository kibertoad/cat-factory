import type { AppConfig } from '@cat-factory/server'
import type { DriveConfig } from './drive.js'
import type { AdvanceQueueOptions, SweeperConfig } from './pgBossRunner.js'

// Translate the runtime-neutral `AppConfig.execution` (durations as strings) into the
// concrete millisecond/second values the pg-boss driver, queue and sweeper need. Shared
// by the container (which builds the work runner) and `start()` (which builds the worker
// + sweeper) so the timing is derived once and stays consistent.

/** Parse a Workflows-style duration ("15 seconds", "5 minutes", "24 hours") to ms. */
export function durationMs(value: string, fallback: number): number {
  const m = /^(\d+)\s*(second|minute|hour)s?$/.exec(value.trim())
  if (!m) return fallback
  const n = Number(m[1])
  const unit = m[2]
  return n * (unit === 'second' ? 1000 : unit === 'minute' ? 60_000 : 3_600_000)
}

export interface ExecutionRuntime {
  drive: DriveConfig
  queue: AdvanceQueueOptions
  sweeper: SweeperConfig
}

/**
 * Derive the driver/queue/sweeper timings from config + env.
 *
 * `queue.expireInSeconds` is sized to comfortably exceed the longest a single advance
 * can run (one container-job poll budget plus one CI poll budget, doubled for a
 * multi-step drive, floored at 1h) so pg-boss never expires a healthy long-running
 * drive out from under its singletonKey. `EXECUTION_DRIVE_EXPIRE_MINUTES` overrides it.
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

  const maxDriveMs = jobPollIntervalMs * exec.jobMaxPolls + ciPollIntervalMs * exec.ciMaxPolls
  const expireMinOverride = Number(env.EXECUTION_DRIVE_EXPIRE_MINUTES)
  const expireInSeconds = Number.isFinite(expireMinOverride)
    ? Math.max(60, expireMinOverride) * 60
    : Math.ceil(Math.max(maxDriveMs * 2, 3_600_000) / 1000)

  const queue: AdvanceQueueOptions = {
    expireInSeconds,
    retryLimit: 5,
    retryDelaySeconds: 30,
  }

  const sweeper: SweeperConfig = {
    intervalMs: Math.max(1, Number(env.STALE_RUN_SWEEP_MINUTES) || 5) * 60_000,
    leaseMs: Math.max(1, Number(env.STALE_RUN_LEASE_MINUTES) || 10) * 60_000,
  }

  return { drive, queue, sweeper }
}
