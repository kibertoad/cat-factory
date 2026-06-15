import type { Env } from '../env'

export interface ExecutionConfig {
  /** Human-decision park timeout passed to the workflow's waitForEvent. */
  decisionTimeout: string
  /** How long the durable driver sleeps between polls of an async container job. */
  jobPollInterval: string
  /**
   * Safety bound on the number of polls before a long-running job is failed, in
   * case a container never reports a terminal state (its own max-duration
   * watchdog should fire first). Sized to comfortably exceed the container's max
   * duration: default 280 × 15s ≈ 70 min vs the harness's 60-min cap.
   */
  jobMaxPolls: number
}

function intEnv(value: string | undefined, fallback: number): number {
  const n = value ? Number(value) : NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export function loadExecutionConfig(env: Env): ExecutionConfig {
  return {
    decisionTimeout: env.DECISION_TIMEOUT?.trim() || '24 hours',
    jobPollInterval: env.JOB_POLL_INTERVAL?.trim() || '15 seconds',
    jobMaxPolls: intEnv(env.JOB_MAX_POLLS, 280),
  }
}
