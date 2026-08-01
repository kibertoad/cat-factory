import type { Logger } from '@cat-factory/kernel'
import type { FoundationalServiceModule } from '@cat-factory/orchestration'

// ---------------------------------------------------------------------------
// The AUTOREFRESH pass for repo-linked foundational-service sources
// (docs/initiatives/foundational-services.md).
//
// It lives here, in the shared server layer, rather than in either facade, because both run
// exactly this pass and only the TRIGGER differs (a Cloudflare cron tick ⇄ a Node interval
// sweeper). Two copies would be two places for the staleness window and the batch bound to
// drift, and a drift there is invisible: the catalog simply refreshes at a different rate on
// one runtime, which nothing fails and nobody notices until a stale contract reaches a coder.
// ---------------------------------------------------------------------------

/**
 * How old a source's last sync may be before the sweep refreshes it. A linked repo's contracts
 * move on human timescales (someone edits an OpenAPI document and merges it), so an hour is the
 * right order of magnitude — long enough that the pass costs one cheap head-commit read per
 * source per hour, short enough that a merged contract change reaches the next day's runs.
 *
 * The refresh itself is nearly free when nothing moved: `syncRepoSource` compares the pinned
 * head commit first and short-circuits the whole reconcile when it has not advanced.
 */
export const FOUNDATIONAL_SOURCE_STALE_MS = 60 * 60_000

/**
 * How many sources one pass refreshes. Bounded so a deployment with hundreds of linked sources
 * spreads the work across successive ticks instead of issuing hundreds of GitHub reads in one
 * pass — and so a Worker pass stays inside its cron CPU budget.
 */
export const FOUNDATIONAL_SOURCE_SWEEP_BATCH = 20

/**
 * Refresh the stalest linked sources. Returns how many were SYNCED (not attempted) — the
 * service logs each individual failure with its cause and continues, so one revoked
 * installation cannot stop the pass from refreshing everyone else's.
 *
 * A no-op returning 0 when the catalog is unconfigured, or configured without the GitHub
 * integration a repo source needs: there is then nothing linked to refresh.
 */
export async function sweepFoundationalSources(
  module: FoundationalServiceModule | undefined,
  logger: Logger,
): Promise<number> {
  const sources = module?.sourceService
  if (!sources) return 0
  const synced = await sources.refreshStale(
    FOUNDATIONAL_SOURCE_STALE_MS,
    FOUNDATIONAL_SOURCE_SWEEP_BATCH,
  )
  if (synced > 0) {
    logger.info('refreshed foundational-service sources', {
      sweep: 'foundational-sources',
      synced,
    })
  }
  return synced
}
