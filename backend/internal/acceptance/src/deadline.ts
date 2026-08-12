// Waiting, with the failure message the wait is actually for.
//
// The rule this file exists to enforce: **a wait that expires must say what it last saw.** An
// anonymous timeout on a real pipeline run reports "timed out after 5400000ms", which is true
// and tells an operator nothing: the run could be parked on a decision nobody answered, stuck
// behind an unwired deploy runner, or simply slower than the budget. All three need different
// fixes and only the last observation distinguishes them.
//
// So every wait here carries a `describe` that renders the CURRENT observation, and the expiry
// message is built from the last one. This is the suite's ONLY clock: the vitest timeout that used
// to sit over it was disabled precisely so this fired first, and `scenarioRunner.ts` deliberately
// introduced no replacement.

/** What one poll saw: either the value the caller wanted, or a description of what it got. */
export type Probe<T> = () => Promise<ProbeResult<T>>
export type ProbeResult<T> = { done: true; value: T } | { done: false; state: string }

export type WaitOptions<T> = {
  /** What is being waited FOR, phrased so it reads in "timed out waiting for <label>". */
  label: string
  probe: Probe<T>
  budgetMs: number
  /**
   * Gap between polls. Defaults to 10s: these are long waits against a live deployment, and a
   * tight poll adds load to the very backend whose slowness is being measured.
   */
  intervalMs?: number
  /** Called with each observation, so a long wait shows progress instead of hanging silently. */
  onProgress?: (state: string, elapsedMs: number) => void
}

const DEFAULT_INTERVAL_MS = 10_000

/**
 * Poll until `probe` reports done, or the budget is spent.
 *
 * The budget is checked BEFORE each sleep rather than after, so a wait never sleeps past its own
 * deadline and then reports the overshoot as the elapsed time.
 */
export async function waitFor<T>(options: WaitOptions<T>): Promise<T> {
  const { label, probe, budgetMs, intervalMs = DEFAULT_INTERVAL_MS, onProgress } = options
  const startedAt = Date.now()
  let lastState = '(nothing observed yet)'

  for (;;) {
    const result = await probe()
    if (result.done) return result.value

    lastState = result.state
    const elapsedMs = Date.now() - startedAt
    onProgress?.(lastState, elapsedMs)

    if (elapsedMs + intervalMs >= budgetMs) {
      throw new Error(formatExpiry(label, lastState, elapsedMs, budgetMs))
    }
    await sleep(intervalMs)
  }
}

/**
 * The expiry message. Split out and exported so `test/deadline.test.ts` can pin that the last
 * observation survives into it: the one property this whole module exists for, and the one a
 * refactor would silently drop by throwing a generic timeout.
 */
export function formatExpiry(
  label: string,
  lastState: string,
  elapsedMs: number,
  budgetMs: number,
): string {
  return (
    `Timed out waiting for ${label} after ${formatDuration(elapsedMs)} ` +
    `(budget ${formatDuration(budgetMs)}).\n` +
    `Last observed: ${lastState}\n` +
    `Nothing was cleaned up: the run, its pull request and any provisioned environment are still ` +
    `there to inspect. Re-run with the same ACCEPTANCE_RUN_ID to resume once the cause is fixed.`
  )
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = Math.round(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  return `${seconds}s`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
