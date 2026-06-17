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
  /**
   * How many *consecutive* polls may fail to READ a job's status before the run is
   * given up. A read failure (e.g. the container is briefly unresponsive while busy
   * with a long install/test command) is not the job failing — eviction returns a
   * 404 to failed state and a real job error returns a failed state, both as values,
   * so a thrown poll error is always a transient read failure. We tolerate a bounded
   * run of them (the counter resets on any successful poll) so a healthy long-running
   * job is never wrongly failed; liveness stays enforced container-side by the
   * inactivity + max-duration watchdogs. Default 6 (each failure already being 3
   * exhausted step-level retries, so this spans several minutes of unreachability).
   */
  jobPollFailureTolerance: number
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
    jobPollFailureTolerance: intEnv(env.JOB_POLL_FAILURE_TOLERANCE, 6),
  }
}
