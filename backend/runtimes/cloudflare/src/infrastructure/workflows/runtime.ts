import type { WorkflowSleepDuration } from 'cloudflare:workers'

/** Minimal slice of `WorkflowStep` this helper needs — just a durable sleep (testable with a fake). */
export interface DurableSleeper {
  sleep(name: string, duration: WorkflowSleepDuration): Promise<void>
}

/** How many times to (re-)attempt the per-wake DI construction before giving up. */
const WORKFLOW_BUILD_ATTEMPTS = 3
/** Durable pause between construction attempts (a wake blip usually clears in seconds). */
const BUILD_RETRY_DELAY: WorkflowSleepDuration = '5 seconds'

/**
 * Assemble a workflow's per-wake runtime (DI container + config), retrying a THROWING build a
 * few times with durable sleeps in between.
 *
 * Why: every workflow's `run()` rebuilds its container at the top of each hibernation wake,
 * OUTSIDE any retriable `step.do`. An unhandled throw there makes the Workflows instance
 * TERMINAL — and a terminal instance id can never be re-created. For a run parked `blocked` on a
 * human decision this is severe (F5): the run is invisible to the cron sweeper, so when the human
 * finally resolves it, the signal hits a dead instance (swallowed), the sweeper later sees a
 * `running` run with a `terminal` instance and STOPS it, and the decision is silently discarded.
 * Surviving a transient wake blip here keeps the parked instance alive so the decision lands.
 *
 * A construction failure that persists across all attempts still surfaces (rethrown) — that is a
 * genuinely broken deployment (e.g. a required binding removed), which SHOULD fail loudly rather
 * than be papered over. This guard only buys resilience against transient failures, not misconfig.
 */
export async function buildWorkflowRuntime<T>(
  build: () => T,
  step: DurableSleeper,
  label: string,
  attempts: number = WORKFLOW_BUILD_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return build()
    } catch (err) {
      lastErr = err
      if (attempt < attempts - 1) {
        await step.sleep(`${label}-build-retry-${attempt}`, BUILD_RETRY_DELAY)
      }
    }
  }
  throw lastErr
}
