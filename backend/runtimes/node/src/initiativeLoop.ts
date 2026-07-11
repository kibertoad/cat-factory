import type { Clock } from '@cat-factory/kernel'
import type { Logger, ServerContainer } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic initiative-execution-loop sweep for the Node facade — the analogue of the Worker's
// every-2-min cron call to `initiatives.loop.runDue`. The Node service has no cron, so a timer
// ticks every executing initiative (reconcile spawned tasks + spawn the next wave). Terminal
// child runs poke the loop directly; this interval is the backstop cadence. No-op when the
// initiatives module isn't wired.

/** Default cadence for the Node initiative-loop sweep (the Worker uses a 2-minute cron). */
const INITIATIVE_LOOP_SWEEP_INTERVAL_MS = 60 * 1000

/**
 * The sweep interval, overridable via `INITIATIVE_LOOP_INTERVAL_MS` (milliseconds) — the same
 * shape as the other Node cadence knobs. Chiefly so a fast integration harness (the e2e suite)
 * can drive the first spawn wave within its timeouts instead of waiting a whole minute for the
 * backstop tick; a non-positive/unparseable value falls back to the default.
 *
 * Reads from the PASSED env (defaulting to `process.env`), NOT `process.env` unconditionally: the
 * Node `start()` takes its config from an INJECTED `env` object that it never writes back to
 * `process.env`, so a deployment (or the e2e backend) that sets the knob there would otherwise be
 * silently ignored and the loop would run at the 60s backstop — which, since the e2e relies on the
 * sweep (not the terminal poke) for the first spawn wave, timed a spawn out past the spec budget.
 */
export function resolveSweepInterval(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INITIATIVE_LOOP_INTERVAL_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : INITIATIVE_LOOP_SWEEP_INTERVAL_MS
}

/**
 * Start the periodic initiative-loop sweep. Runs once immediately then on the resolved interval
 * (default one minute; see {@link resolveSweepInterval}), non-overlapping + best-effort (see
 * {@link startSweeper}). The non-overlap guard matters most here: `runDue` reconciles spawned
 * tasks and spawns the next wave, so two concurrent passes could both observe "no active run"
 * and double-spawn. Returns a stop function that clears the timer.
 */
export function startInitiativeLoopSweeper(
  container: ServerContainer,
  clock: Clock,
  log: Logger,
  intervalMs: number = resolveSweepInterval(),
): () => void {
  const initiatives = container.initiatives
  if (!initiatives) return () => {}
  return startSweeper({
    name: 'initiative-loop',
    intervalMs,
    log,
    failureMessage: 'initiative-loop sweep failed',
    tick: async () => {
      const { spawned, completed } = await initiatives.loop.runDue(clock.now())
      if (spawned > 0 || completed > 0) {
        log.info({ spawned, completed }, 'ticked initiative loop')
      }
    },
  })
}
