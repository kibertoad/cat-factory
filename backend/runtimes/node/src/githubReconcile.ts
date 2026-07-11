import type { Clock } from '@cat-factory/kernel'
import { type GitHubReconcileDeps, type Logger, reconcileStaleRepos } from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic GitHub reconciliation for the Node facade — the analogue of the Worker's
// every-2-min `github-reconcile` cron. Webhooks are the primary sync path but can be
// missed (a delivery outage, a restart mid-delivery), so this backstop re-syncs every
// tracked repo whose projection has gone stale. The reconcile pass itself lives in the
// shared `@cat-factory/server` `reconcileStaleRepos` (so it can't drift from the Worker);
// this file supplies only the Node driver — a direct inline resync (Node has no queue).
// The pass itself is unit-tested in `@cat-factory/server` (one test for one implementation).

/** How often the reconcile pass runs (matches the Worker's frequent cron). */
const GITHUB_RECONCILE_INTERVAL_MS = 2 * 60 * 1000
/** A projection not synced for this long is considered stale (matches the Worker). */
const GITHUB_RECONCILE_STALE_MS = 30 * 60 * 1000

/**
 * Start the periodic reconcile sweep. Runs once immediately then on the two-minute
 * timer, non-overlapping + best-effort (see {@link startSweeper}). Returns a stop
 * function that clears the timer.
 */
export function startGitHubReconcileSweeper(
  deps: GitHubReconcileDeps,
  clock: Clock,
  log: Logger,
): () => void {
  return startSweeper({
    intervalMs: GITHUB_RECONCILE_INTERVAL_MS,
    log,
    failureMessage: 'github reconcile sweep failed',
    tick: async () => {
      const synced = await reconcileStaleRepos(deps, clock, GITHUB_RECONCILE_STALE_MS, log)
      if (synced > 0) log.info({ synced }, 'reconciled stale github repo projections')
    },
  })
}
