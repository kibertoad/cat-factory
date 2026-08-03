import { describeError } from '@cat-factory/kernel'
import { sweepHealth } from '@cat-factory/server'
import type { ExecutionContext } from '@cloudflare/workers-types'
import { logger } from './logger'

// One cron tick's background passes, and the Worker's half of the sweep-health contract.
//
// This is the facade-symmetric twin of the Node facade's `startSweeper` (`node/src/sweeper.ts`):
// a pass is named, its failure message is fixed, its outcome is REPORTED, and the report is one
// call so no site can emit half of it. The two runtimes had drifted badly without it — Node
// recorded a streak for every `startSweeper` sweep while the Worker recorded one for exactly the
// stale-run sweep, so `sweep_degraded` described a different set of sweepers on each facade and
// a wedged retention cron on Cloudflare raised nothing at all.
//
// It also owns the tick's FLUSH ORDERING, which a bare `ctx.waitUntil` per sweep cannot. The
// operational collector is per ISOLATE here, so the counters a cron pass records are only ever
// exported by a flush that runs AFTER that pass. Draining while the passes were still in flight
// (the shape this replaced) meant a cron tick drained an empty collector and its own counters
// waited for a NEXT tick in the SAME isolate — which, for the daily retention cron, is a tick
// that essentially never comes.

/** What {@link SweepTick.run} needs to describe one pass. */
export interface CronSweepPass {
  /** Sweep name — the `sweep` dimension and the `sweep_degraded` streak key. Bounded set. */
  name: string
  /** The message logged (with the cause bound) when the pass rejects. */
  failureMessage: string
}

/**
 * Collects the passes registered during one cron tick so the operational-metrics flush can be
 * ordered after all of them, and records each pass's outcome on the way through.
 */
export class SweepTick {
  private readonly passes: Promise<unknown>[] = []

  constructor(private readonly ctx: ExecutionContext) {}

  /**
   * Register one background sweep pass. It rides `ctx.waitUntil` exactly as before AND its
   * outcome is recorded under `name`, so a Worker sweep that has been throwing every tick shows
   * up as both a rate (`sweep.failed`) and a streak (`sweep_degraded`).
   *
   * Pass the promise WITHOUT a trailing `.catch` — the rejection is this method's to observe.
   * Success-path logging still belongs on the caller's own `.then`, because only the caller
   * knows what its result means.
   */
  run({ name, failureMessage }: CronSweepPass, pass: Promise<unknown>): void {
    const tracked = pass.then(
      () => {
        sweepHealth.recordSuccess(name)
      },
      (error: unknown) => {
        logger.error(failureMessage, { cron: name, ...describeError(error) })
        sweepHealth.recordFailure(name)
      },
    )
    this.passes.push(tracked)
    this.ctx.waitUntil(tracked)
  }

  /**
   * Every pass registered so far, settled. `allSettled` because a pass's rejection is already
   * reported by {@link run} — this is an ordering barrier, not an error channel.
   */
  settled(): Promise<unknown> {
    return Promise.allSettled(this.passes)
  }
}
