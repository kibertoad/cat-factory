import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'

// Periodic Kaizen grading sweep for the Node facade — the analogue of the Worker's
// every-2-min cron call to `kaizen.service.runPending`. The engine only inserts
// `scheduled` rows at run completion, so this timer does the actual LLM grading (and
// re-drives `running` rows orphaned by a crashed sweep). No-op when Kaizen isn't wired.

/** How often the Node service runs pending Kaizen gradings (matches the Worker's cron). */
export const KAIZEN_SWEEP_INTERVAL_MS = 2 * 60 * 1000
/** A `running` grading older than this is re-driven (its sweep crashed mid-flight). */
export const KAIZEN_STALE_MS = 10 * 60 * 1000
/** Max gradings to run per pass (each is an LLM call; keep the batch small). */
export const KAIZEN_SWEEP_BATCH = 5

/**
 * Start the periodic Kaizen grading sweep. Runs once immediately then on a one-minute
 * timer. Best-effort: a failed pass is logged and retried next tick, never thrown.
 * Returns a stop function that clears the timer.
 */
export function startKaizenSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
): () => void {
  const kaizen = container.kaizen
  if (!kaizen) return () => {}
  let running = false
  const tick = async () => {
    // Skip if the previous pass is still in flight: a batch of LLM gradings can outlast the
    // interval, and setInterval would otherwise stack overlapping passes against the same rows.
    if (running) return
    running = true
    try {
      const processed = await kaizen.service.runPending(
        clock.now() - KAIZEN_STALE_MS,
        KAIZEN_SWEEP_BATCH,
      )
      if (processed > 0) log.info({ processed }, 'ran pending kaizen gradings')
    } catch (error) {
      log.error(
        { err: error instanceof Error ? error.message : String(error) },
        'kaizen sweep failed',
      )
    } finally {
      running = false
    }
  }
  void tick()
  const timer = setInterval(() => void tick(), KAIZEN_SWEEP_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
