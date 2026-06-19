import type { ExecutionConfig } from '@cat-factory/server'
import type { Env } from '../env'

export type { ExecutionConfig }

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadExecutionConfig(env: Env): ExecutionConfig {
  return {
    decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    jobPollInterval: env.JOB_POLL_INTERVAL?.trim() || '15 seconds',
    jobMaxPolls: intEnv(env.JOB_MAX_POLLS, 280),
    jobPollFailureTolerance: intEnv(env.JOB_POLL_FAILURE_TOLERANCE, 6),
    ciPollInterval: env.CI_POLL_INTERVAL?.trim() || '30 seconds',
    ciMaxPolls: intEnv(env.CI_MAX_POLLS, 120),
    // Hard floor of 75 min: a misconfigured low value must never reap live work
    // (the longest legitimate container lifetime is ≈70 min of driver polling).
    containerMaxAgeMs: Math.max(75, intEnv(env.CONTAINER_MAX_AGE_MINUTES, 90)) * 60_000,
  }
}
