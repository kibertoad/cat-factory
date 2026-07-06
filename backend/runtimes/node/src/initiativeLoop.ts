import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'

// Periodic initiative-execution-loop sweep for the Node facade — the analogue of the Worker's
// every-2-min cron call to `initiatives.loop.runDue`. The Node service has no cron, so a timer
// ticks every executing initiative (reconcile spawned tasks + spawn the next wave). Terminal
// child runs poke the loop directly; this interval is the backstop cadence. No-op when the
// initiatives module isn't wired.

/** Default cadence for the Node initiative-loop sweep (the Worker uses a 2-minute cron). */
export const INITIATIVE_LOOP_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * The sweep interval, overridable via `INITIATIVE_LOOP_INTERVAL_MS` (milliseconds) — the same
 * shape as the other Node cadence knobs. Chiefly so a fast integration harness (the e2e suite)
 * can drive the first spawn wave within its timeouts instead of waiting a whole minute for the
 * backstop tick; a non-positive/unparseable value falls back to the default.
 */
function resolveSweepInterval(): number {
  const raw = process.env.INITIATIVE_LOOP_INTERVAL_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : INITIATIVE_LOOP_SWEEP_INTERVAL_MS
}

/**
 * Start the periodic initiative-loop sweep. Runs once immediately then on the resolved interval
 * (default one minute; see {@link resolveSweepInterval}). Best-effort: a failed sweep is logged
 * and retried next tick, never thrown. Returns a stop function that clears the timer.
 */
export function startInitiativeLoopSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
  intervalMs: number = resolveSweepInterval(),
): () => void {
  const initiatives = container.initiatives
  if (!initiatives) return () => {}
  const tick = async () => {
    try {
      const { spawned, completed } = await initiatives.loop.runDue(clock.now())
      if (spawned > 0 || completed > 0) {
        log.info({ spawned, completed }, 'ticked initiative loop')
      }
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'initiative-loop sweep failed',
      )
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
