import {
  DEFAULT_ADVANCE_TIMEOUT,
  DEFAULT_CI_POLL_INTERVAL,
  DEFAULT_DECISION_TIMEOUT,
  DEFAULT_JOB_POLL_INTERVAL,
  type ExecutionConfig,
  resolveDurationEnv,
} from '@cat-factory/server'
import type { Env } from '../env'

export type { ExecutionConfig }

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadExecutionConfig(env: Env): ExecutionConfig {
  return {
    // NOT a hard deadline: a parked run waits for a human indefinitely and is never failed
    // for waiting. This is just the chunk length for each `waitForEvent` wait — on expiry the
    // driver re-loops (re-checking storage, then re-arming) rather than killing the run.
    //
    // Every duration below is resolved through the SHARED parser, which is what keeps this
    // facade and Node reading one value the same way: the string stored here is canonical, so
    // what reaches `step.sleep` / `step.do` is always a form Workflows admits, and a value
    // neither runtime can honour falls back to the same default on both with one warning.
    decisionTimeout: resolveDurationEnv(
      'DECISION_TIMEOUT',
      env.DECISION_TIMEOUT,
      DEFAULT_DECISION_TIMEOUT,
    ).canonical,
    jobPollInterval: resolveDurationEnv(
      'JOB_POLL_INTERVAL',
      env.JOB_POLL_INTERVAL,
      DEFAULT_JOB_POLL_INTERVAL,
    ).canonical,
    jobMaxPolls: intEnv(env.JOB_MAX_POLLS, 280),
    jobPollFailureTolerance: intEnv(env.JOB_POLL_FAILURE_TOLERANCE, 6),
    ciPollInterval: resolveDurationEnv(
      'CI_POLL_INTERVAL',
      env.CI_POLL_INTERVAL,
      DEFAULT_CI_POLL_INTERVAL,
    ).canonical,
    ciMaxPolls: intEnv(env.CI_MAX_POLLS, 120),
    // The per-durable-step ceiling the Workflows driver wraps each advance and status read in.
    // Node races the same value in `driveExecution`, which is why it is one knob.
    advanceTimeout: resolveDurationEnv(
      'ADVANCE_TIMEOUT',
      env.ADVANCE_TIMEOUT,
      DEFAULT_ADVANCE_TIMEOUT,
    ).canonical,
    // Hard floor of 75 min: a misconfigured low value must never reap live work
    // (the longest legitimate container lifetime is ≈70 min of driver polling).
    containerMaxAgeMs: Math.max(75, intEnv(env.CONTAINER_MAX_AGE_MINUTES, 90)) * 60_000,
  }
}
