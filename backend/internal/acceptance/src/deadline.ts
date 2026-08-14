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
//
// **A THROWN probe is the second half of that rule**, and it used to escape it. A poll against a
// deployment that is momentarily not listening threw an SDK transport error straight past this
// module, so a 41-minute pass died on one refused connection while the run it was watching carried
// on to a pull request. The tolerance below is what makes an outage an OBSERVATION for a bounded
// window: the policy (which throws are outages, and how long one may last) is injected, because
// this module is the clock and has no business knowing what a deployment is. `deploymentOutage.ts`
// owns that judgement.
//
// **An outage is journalled but never becomes the LAST OBSERVATION**, and that is the rule above
// defending itself against its own tolerance. "The deployment did not answer (refused)" says
// nothing whatever about the run, so letting it overwrite the last real observation would leave
// both expiry messages reporting the silence and nothing else, while `formatOutage` was still
// telling its reader the run may well be fine, having just thrown away the only evidence about it.

/** What one poll saw: either the value the caller wanted, or a description of what it got. */
export type Probe<T> = () => Promise<ProbeResult<T>>
export type ProbeResult<T> = { done: true; value: T } | { done: false; state: string }

/**
 * How a wait treats a THROWN probe.
 *
 * `describe` returns the observation to keep waiting on, or `null` for a throw that must end the
 * wait. The distinction is the whole point: an unreachable deployment is a gap in the evidence and
 * a REFUSAL is evidence, so the second kind is rethrown untouched rather than sat through.
 */
export type ProbeTolerance = {
  describe: (error: unknown) => string | null
  /** How long the described outage may last, in ms, before the wait gives up on it. */
  graceMs: number
}

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
  /** Absent ⇒ any thrown probe ends the wait, which is the right default for a local probe. */
  tolerate?: ProbeTolerance
}

const DEFAULT_INTERVAL_MS = 10_000

/**
 * Poll until `probe` reports done, or the budget is spent.
 *
 * The budget is checked BEFORE each sleep rather than after, so a wait never sleeps past its own
 * deadline and then reports the overshoot as the elapsed time.
 *
 * A tolerated throw becomes an ordinary not-done observation, so it is journalled and counted
 * against the same budget exactly as a poll that answered would be. What it does NOT become is the
 * last observation: an expiry reports the last thing the deployment actually SAID, plus the silence
 * as a separate clause when the wait ended inside one. Only the outage's OWN grace expiring
 * short-circuits the budget, and it says so in its own words.
 */
export async function waitFor<T>(options: WaitOptions<T>): Promise<T> {
  const { label, probe, budgetMs, intervalMs = DEFAULT_INTERVAL_MS, onProgress, tolerate } = options
  const startedAt = Date.now()
  let lastAnswer = '(nothing observed yet)'
  let outageStartedAt: number | null = null

  for (;;) {
    let result: ProbeResult<T>
    let answered = true
    try {
      result = await probe()
      if (outageStartedAt !== null) {
        // Worth its own line: a deployment that went away and came back is a fact about the pass
        // (a supervisor repaired it, a watch-mode restart cycled it), and without this the journal
        // shows an unexplained gap in the observations.
        const outageMs = Date.now() - outageStartedAt
        outageStartedAt = null
        onProgress?.(
          `the deployment answered again after ${formatDuration(outageMs)} of silence`,
          Date.now() - startedAt,
        )
      }
    } catch (error) {
      // No tolerance configured, or a throw the tolerance does not own: rethrow UNTOUCHED. Wrapping
      // it would cost the typed SDK error every caller above reads its status and request id off.
      if (tolerate === undefined) throw error
      const outage = tolerate.describe(error)
      if (outage === null) throw error
      answered = false
      outageStartedAt ??= Date.now()
      const outageMs = Date.now() - outageStartedAt
      if (outageMs >= tolerate.graceMs) {
        // BOTH facts: the silence (which carries the transport cause, the half that says what to
        // fix) and the last ANSWER (what the run was doing, the half that says whether to worry).
        // Either alone was a message that answered half of what its own advice asks the reader.
        throw new Error(formatOutage(label, outage, lastAnswer, outageMs, tolerate.graceMs))
      }
      result = { done: false, state: `${outage} (no answer for ${formatDuration(outageMs)})` }
    }

    if (result.done) return result.value

    if (answered) lastAnswer = result.state
    const elapsedMs = Date.now() - startedAt
    onProgress?.(result.state, elapsedMs)

    if (elapsedMs + intervalMs >= budgetMs) {
      throw new Error(
        formatExpiry(label, lastAnswer, elapsedMs, budgetMs, answered ? undefined : result.state),
      )
    }
    await sleep(intervalMs)
  }
}

/**
 * The expiry message. Split out and exported so `test/deadline.test.ts` can pin that the last
 * observation survives into it: the one property this whole module exists for, and the one a
 * refactor would silently drop by throwing a generic timeout.
 *
 * `lastState` is the last thing the deployment ANSWERED. `silence` is the separate fact that the
 * budget ran out while it was not answering, and it is a second clause rather than a replacement
 * because the two are read together: an observation from four minutes ago is worth having, and
 * worth knowing to be four minutes old.
 */
export function formatExpiry(
  label: string,
  lastState: string,
  elapsedMs: number,
  budgetMs: number,
  silence?: string,
): string {
  return (
    `Timed out waiting for ${label} after ${formatDuration(elapsedMs)} ` +
    `(budget ${formatDuration(budgetMs)}).\n` +
    `Last observed: ${lastState}\n` +
    (silence
      ? `The budget ran out mid-outage, so that observation predates it: ${silence}\n`
      : '') +
    leftInPlace()
  )
}

/**
 * The message for an outage that outlasted its grace, which is a DIFFERENT failure from an expiry
 * and reads as one: the run under observation is not what stopped, so nothing about it is evidence
 * here, and the thing to go and look at is the deployment rather than the pipeline.
 *
 * It carries TWO observations because its own advice needs both. `outage` is the silence, and with
 * it the transport cause, which is what says where the fix is. `lastState` is the last thing the
 * deployment ANSWERED, which is what says whether the run is worth worrying about; a message that
 * printed the silence in that slot told its reader the run may well be fine while having discarded
 * the only evidence about it.
 */
export function formatOutage(
  label: string,
  outage: string,
  lastState: string,
  outageMs: number,
  graceMs: number,
): string {
  return (
    `The deployment stopped answering while waiting for ${label}, and has now been silent for ` +
    `${formatDuration(outageMs)} (a wait sits through ${formatDuration(graceMs)} of it, which ` +
    `covers a restart).\n` +
    `No answer since: ${outage}\n` +
    `Last observed: ${lastState}\n` +
    `The run itself may well be fine: a deployment that restarts re-drives it. Check that the ` +
    `backend is up before reading anything into the run.\n${leftInPlace()}`
  )
}

/**
 * What is still on the deployment after a wait gave up, and how to pick it back up.
 *
 * Shared by both messages because it is true of both and a reader needs it in either: this suite
 * deliberately cleans nothing up, and an operator who assumes otherwise starts a second pass that
 * `board-titles` then refuses.
 */
function leftInPlace(): string {
  return (
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
