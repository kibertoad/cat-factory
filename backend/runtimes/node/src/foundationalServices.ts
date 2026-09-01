import {
  FOUNDATIONAL_SOURCE_STALE_MS,
  SERVICE_CATALOG_STALE_MS,
  sweepFoundationalSources,
  sweepServiceCatalogs,
  type Logger,
  type ServerContainer,
  type SweepHealthTracker,
} from '@cat-factory/server'
import { startSweeper } from './sweeper.js'

// Periodic AUTOREFRESH of repo-linked foundational-service sources for the Node facade — the
// analogue of the Worker's cron-driven pass. Both run the SAME `sweepFoundationalSources` from
// the shared server layer (which owns the staleness window and the batch bound); only the
// trigger differs, because the Node service has no cron.

/**
 * How often the sweep runs. Matched to the staleness window itself rather than set shorter: a
 * source cannot go stale more often than the window, so a tighter cadence would only re-issue
 * the same head-commit probes. The Worker gates its 2-minute cron down to the same effective
 * cadence for the same reason.
 */
const FOUNDATIONAL_SWEEP_INTERVAL_MS = FOUNDATIONAL_SOURCE_STALE_MS

/**
 * Start the periodic foundational-source refresh. Runs once immediately then on the interval,
 * non-overlapping + best-effort (see {@link startSweeper}). A no-op when the catalog is not
 * configured, or is configured without the GitHub integration a repo source needs.
 */
export function startFoundationalSourceSweeper(
  container: ServerContainer,
  log: Logger,
  /** Records each pass's outcome under this sweep's name (see {@link startSweeper}). */
  health: SweepHealthTracker,
): () => void {
  if (!container.foundationalServices?.sourceService) return () => {}
  return startSweeper({
    name: 'foundational-sources',
    intervalMs: FOUNDATIONAL_SWEEP_INTERVAL_MS,
    log,
    health,
    failureMessage: 'foundational-source sweep failed',
    tick: async () => {
      await sweepFoundationalSources(container.foundationalServices, log)
    },
  })
}

/**
 * Start the periodic SERVICE-CATALOG refresh: the Node analogue of the Worker's cron pass, over
 * the same shared `sweepServiceCatalogs` (which owns the window and the batch bound).
 *
 * Its own sweeper rather than another `tick` inside the one above, because the two have different
 * windows for a real reason: a repo source's refresh is one conditional head-commit read, and a
 * portal import pages the estate. Folding them would make the cheaper pass run at the slower
 * cadence or the expensive one at the faster.
 */
export function startServiceCatalogSweeper(
  container: ServerContainer,
  log: Logger,
  health: SweepHealthTracker,
): () => void {
  if (!container.foundationalServices?.serviceCatalog) return () => {}
  return startSweeper({
    name: 'service-catalog',
    intervalMs: SERVICE_CATALOG_STALE_MS,
    log,
    health,
    failureMessage: 'service-catalog sweep failed',
    tick: async () => {
      await sweepServiceCatalogs(container.foundationalServices, log)
    },
  })
}
