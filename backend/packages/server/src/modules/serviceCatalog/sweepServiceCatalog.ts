import type { Logger } from '@cat-factory/kernel'
import type { FoundationalServiceModule } from '@cat-factory/orchestration'

// ---------------------------------------------------------------------------
// The AUTOREFRESH pass for connected SERVICE CATALOGS (the developer portals whose services are
// imported into the foundational-services catalog).
//
// In the shared server layer beside `sweepFoundationalSources`, and for the same reason: both
// facades run exactly this pass and only the trigger differs (a Cloudflare cron tick versus a
// Node interval sweeper). Two copies would be two places for the staleness window to drift, and
// that drift is invisible: the catalog simply refreshes at a different rate on one runtime,
// which nothing fails and nobody notices until a retired service is still being handed to an
// agent as current.
// ---------------------------------------------------------------------------

/**
 * How old a connection's last import may be before the sweep refreshes it.
 *
 * Six hours rather than the linked repo source's hour, because the two passes cost very different
 * things. A repo source's refresh is one head-commit read that short-circuits when nothing moved;
 * a portal import has no equivalent cheap "did anything change" probe, so every pass pages the
 * matching estate and fetches the API definitions. A service catalog also moves on slower
 * timescales than a spec file: components are added and retired on the order of days.
 */
export const SERVICE_CATALOG_STALE_MS = 6 * 60 * 60_000

/**
 * How many connections one pass refreshes. Bounded so a deployment with hundreds of connected
 * workspaces spreads the work across successive ticks rather than issuing hundreds of paged
 * portal reads at once, and so a Worker pass stays inside its cron CPU budget.
 *
 * Smaller than the repo-source batch for the same reason the window is longer: one unit of work
 * here is a paged listing plus a batched definition fetch, not a single conditional read.
 */
export const SERVICE_CATALOG_SWEEP_BATCH = 5

/**
 * Refresh the stalest connected catalogs. Returns how many were IMPORTED, not attempted: the
 * importer records each failure on its own connection and logs the cause, so one workspace's
 * revoked portal token cannot stop the pass from refreshing everyone else's estate.
 *
 * A no-op returning 0 when the catalog is unconfigured, or configured without the service-catalog
 * encryption key the connection needs: there is then nothing connected to refresh.
 */
export async function sweepServiceCatalogs(
  module: FoundationalServiceModule | undefined,
  logger: Logger,
): Promise<number> {
  const serviceCatalog = module?.serviceCatalog
  if (!serviceCatalog) return 0
  const imported = await serviceCatalog.syncService.refreshStale(
    SERVICE_CATALOG_STALE_MS,
    SERVICE_CATALOG_SWEEP_BATCH,
  )
  if (imported > 0) {
    logger.info('refreshed connected service catalogs', {
      sweep: 'service-catalog',
      imported,
    })
  }
  return imported
}
