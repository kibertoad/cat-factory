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
  /**
   * How long the durable driver sleeps between polls of a `ci` step's CI status.
   * CI runs (GitHub Actions etc.) take minutes, so this is coarser than the job
   * poll. Default 30 seconds.
   */
  ciPollInterval: string
  /**
   * Safety bound on the number of CI polls before the gate is given up (in case CI
   * never reports a terminal state). Sized to comfortably exceed a long CI run:
   * default 120 × 30s = 60 min. Note the CI-fixer loop has its own per-task attempt
   * budget; this only bounds a single `checking` wait.
   */
  ciMaxPolls: number
  /**
   * Age ceiling for the instance-level container reaper (epoch-ms). The cron reaper
   * SIGKILLs any per-run container whose first dispatch is older than this — the
   * load-bearing backstop for a container the run record can no longer reach (a
   * terminal run whose container survived, or a stuck-`running` run held warm by a
   * live driver). Sized above the longest legitimate lifetime: the harness caps a
   * job at 60 min and the driver at ≈70 min of polling, so 90 min clears the tail.
   * Floored at 75 min so a misconfigured low value can't reap live work. Config:
   * `CONTAINER_MAX_AGE_MINUTES` (default 90, clamped to ≥75).
   */
  containerMaxAgeMs: number
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
    ciPollInterval: env.CI_POLL_INTERVAL?.trim() || '30 seconds',
    ciMaxPolls: intEnv(env.CI_MAX_POLLS, 120),
    // Hard floor of 75 min: a misconfigured low value must never reap live work
    // (the longest legitimate container lifetime is ≈70 min of driver polling).
    containerMaxAgeMs: Math.max(75, intEnv(env.CONTAINER_MAX_AGE_MINUTES, 90)) * 60_000,
  }
}
