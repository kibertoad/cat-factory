import { describeError, type Logger } from '@cat-factory/kernel'
import type { SweepHealthTracker } from '@cat-factory/server'
import { AsyncTask, SimpleIntervalJob, ToadScheduler } from 'toad-scheduler'

// The Node facade has no cron, so every periodic task the Worker runs on a schedule is an
// interval timer here (Kaizen grading, initiative loop, recurring pipelines, notification
// escalation, GitHub reconcile, ephemeral-environment + retention sweeps). They all share
// the same shape — run once immediately, then on the interval, best-effort (a failed pass
// is logged, never thrown) — and, critically, they must NOT overlap: a pass that outlasts
// its interval would otherwise be stacked, so two concurrent passes could both observe "no
// active run" and double-spawn / double-process the same rows.
//
// Rather than hand-roll a `running` flag per sweeper (which the DB-heavy ones used to
// forget), every sweep goes through `toad-scheduler`: a `SimpleIntervalJob` with
// `preventOverrun` gives the non-overlap guard, `runImmediately` the run-once-first
// behaviour, and the `AsyncTask` error handler the best-effort logging. This helper is the
// single place that wiring lives, so a new sweeper can't get it wrong.

/** A best-effort periodic sweep started via {@link startSweeper}. */
export interface SweeperOptions {
  /** Short sweep name, used as the toad-scheduler task id (so a scheduler-surfaced error names its sweep). */
  name: string
  /** How often to run the sweep. */
  intervalMs: number
  /** Logger for the best-effort failure line. */
  log: Logger
  /**
   * Where each pass's OUTCOME is recorded, under {@link name} — the `sweep.failed` rate and
   * the consecutive-failure streak `sweep_degraded` reads, which the tracker emits together.
   * REQUIRED rather than optional: a sweeper that has been throwing every tick for a week logs
   * one line per tick and nothing that says the rate changed, and an optional sink here would
   * be forgotten by exactly the sweeper nobody is watching. A caller with nothing to export
   * passes `createSweepHealthTracker()`, which says so in code.
   */
  health: SweepHealthTracker
  /** The message logged (with the error) when a pass throws. */
  failureMessage: string
  /** One sweep pass. Any success logging lives inside it; throws are caught + logged. */
  tick: () => Promise<void>
}

/**
 * Start a periodic, non-overlapping, best-effort sweep. Runs `tick` once immediately then
 * on the interval; skips a tick while the previous pass is still in flight
 * (`preventOverrun`); logs (never throws) a failed pass; never keeps the process alive on
 * the sweep timer alone (`unref`, matching the hand-rolled `setInterval(...).unref()`
 * timers this replaced). Returns a stop function that halts the job — still call it on
 * shutdown so a long pass in flight can't outlive the rest of the teardown.
 */
export function startSweeper(options: SweeperOptions): () => void {
  const { name, intervalMs, log, health, failureMessage, tick } = options
  const scheduler = new ToadScheduler()
  // The success side is recorded too, and it is what makes the streak mean something: without
  // it `sweep_degraded` would fire on the third failure a sweeper ever had, however far apart.
  const task = new AsyncTask(
    name,
    async () => {
      await tick()
      health.recordSuccess(name)
    },
    (error) => {
      log.error(failureMessage, describeError(error))
      health.recordFailure(name)
    },
  )
  const job = new SimpleIntervalJob({ milliseconds: intervalMs, runImmediately: true }, task, {
    preventOverrun: true,
    unref: true,
  })
  scheduler.addSimpleIntervalJob(job)
  return () => scheduler.stop()
}
