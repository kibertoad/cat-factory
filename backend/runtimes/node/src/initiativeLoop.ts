import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'

// Periodic initiative-execution-loop sweep for the Node facade — the analogue of the Worker's
// every-2-min cron call to `initiatives.loop.runDue`. The Node service has no cron, so a timer
// ticks every executing initiative (reconcile spawned tasks + spawn the next wave). Terminal
// child runs poke the loop directly; this interval is the backstop cadence. No-op when the
// initiatives module isn't wired.

/** How often the Node service ticks the initiative loop. */
export const INITIATIVE_LOOP_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Start the periodic initiative-loop sweep. Runs once immediately then on a one-minute timer.
 * Best-effort: a failed sweep is logged and retried next tick, never thrown. Returns a stop
 * function that clears the timer.
 */
export function startInitiativeLoopSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
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
  const timer = setInterval(() => void tick(), INITIATIVE_LOOP_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
