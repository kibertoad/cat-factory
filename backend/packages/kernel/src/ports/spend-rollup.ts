import type { ReportSpendDimension } from '@cat-factory/contracts'
import type {
  ReportRange,
  ReportScope,
  ReportSpendGroup,
  ReportSpendTrendBucket,
} from './reports.js'

// The DURABLE cost-attribution rollup: `spend_days`, one aggregated row per
// `(workspace, UTC day, run, agent kind, provider:model, billing, vendor)` with the run's
// board shape (service, repository, task type, tracker ticket) FROZEN onto it at rollup time.
//
// It exists because the TCO axes could not be produced from durable data. `ReportsRepository`
// answers the same questions off the raw ledger, but every answer it gives about a repository
// or a ticket is assembled at READ time from three mutable sources: `token_usage`, which the
// retention sweep prunes; `agent_runs`, whose row a call joins through to reach the board at
// all; and the LIVE `services.repo_github_id` / `tasks.linked_block_id` links, which an
// operator re-points whenever a service moves repository or an issue is re-imported. Each of
// those is correct for "what is this costing me now" and wrong for "what did this repository
// cost us last quarter": the same question asked twice, a year apart, gets two different
// answers, and the second one is silently smaller.
//
// So this rollup is written by the retention sweep, from the ledger, BEFORE the sweep prunes
// it, and it carries the attribution as it stood while the money was being spent. Reading it
// touches no other table.
//
// **It has NO retention.** There is deliberately no `deleteOlderThan` here, and the sweep that
// materialises it prunes every other table it touches. That is the point of the port: a TCO
// table has to outlive the ledger it was folded from, and a rollup with a window is just a
// slower ledger. The cost is stated rather than hidden: the grain is one row per run per
// (agent kind, model, billing), which is roughly a handful of rows per run against the
// hundreds of ledger rows a run produces, so the table grows with RUN volume and never with
// call volume. See `backend/docs/storage-and-retention.md` §1c for the arithmetic.

/**
 * The rollup's name in the deployment-scoped `platform_rollup_state` coverage marker, beside
 * the daily run rollup's. The marker records what the SWEEP covered, which is why it cannot be
 * derived from `max(day_start)` over the rolled-up rows: an account that spent nothing for a
 * fortnight and a sweep that has been wedged for a fortnight produce the same newest row, and
 * they need opposite responses.
 */
export const SPEND_DAYS_ROLLUP = 'spend_days'

export interface SpendRollupRepository {
  /**
   * Materialise the durable rollup for every UTC day overlapping `[fromEpochMs, toEpochMs)`,
   * as ONE `INSERT … SELECT … GROUP BY` over `token_usage` joined to the run's board shape.
   * Never a read-into-JS-and-write-back. Returns the number of buckets written.
   *
   * REWRITTEN, never appended: each pass DELETEs the window and re-inserts it in one
   * transaction, because an upsert is not a rewrite. Today's buckets are still accruing, a
   * missed pass would otherwise leave a day permanently half-counted (indistinguishable from a
   * quiet day, and permanent here in a way it is not in a pruned table), and a ledger row that
   * arrives late for a day already rolled up would be lost to the aggregate that outlives it.
   *
   * The rewrite reaches only workspaces that STILL EXIST, and that bound is what makes this
   * table's exclusion from the workspace-delete cascade real rather than nominal. `token_usage`
   * IS cascaded, so once a board is deleted the fold reads nothing for it: a rewrite that
   * deleted the window unconditionally would reclaim every frozen row of that board still
   * inside the trailing window, which is the last few days of its history and the part a
   * reader is most likely to look at. The general rule the bound states is that a rewrite may
   * only delete what it can reproduce.
   *
   * The pass also records its coverage under {@link SPEND_DAYS_ROLLUP} in the same
   * transaction, forward-only, so {@link spendRollupWatermark} describes the rows that exist.
   */
  rollupSpendDays(fromEpochMs: number, toEpochMs: number): Promise<number>
  /**
   * The same fold, narrowed to ONE workspace: the LAST one a board ever gets, run inside its own
   * deletion while its ledger rows are still there to be folded.
   *
   * {@link rollupSpendDays} deliberately reaches only boards that still exist, which keeps a
   * sweep from reclaiming a deleted board's frozen rows but leaves the mirror-image gap: the
   * board's spend SINCE the last completed rollup day was never folded, and `token_usage` IS in
   * the workspace-delete cascade, so those rows go before any pass sees them. The loss is
   * bounded by the sweep interval and permanent, and a TCO table that silently drops the final
   * hours of every board that was ever tidied up is understating exactly the boards an operator
   * deleted because they were expensive. So the delete folds them itself, BEFORE the cascade.
   *
   * Two properties make it safe to call and are not optional:
   *
   * - It is still bounded to workspaces that EXIST, for the same reason the sweep is. Called
   *   after the cascade it would delete its window and re-fold nothing, reclaiming the very rows
   *   the exclusion in `WORKSPACE_CASCADE_SPECIAL_TABLES` exists to keep. The bound
   *   makes that a no-op rather than a data loss, so the ordering is enforced by the query and
   *   not only by the call site.
   * - It does NOT touch the coverage marker. {@link spendRollupWatermark} is deployment-scoped
   *   and answers "how far has the SWEEP got" for every board at once; one board's final fold
   *   covers no other board's days, so advancing it would present days nothing folded as
   *   covered, and the marker only ever moves forward, so nothing could walk it back.
   *
   * Returns the number of buckets written.
   */
  rollupWorkspaceSpendDays(
    workspaceId: string,
    fromEpochMs: number,
    toEpochMs: number,
  ): Promise<number>
  /**
   * The newest COMPLETE UTC day the rollup SWEEP has covered (epoch ms, midnight), or null
   * when no pass has ever completed. Read from the sweep's own recorded coverage,
   * deployment-scoped, for the reasons on `PlatformMetricsRepository.dailyRollupWatermark`.
   *
   * COMPLETE is the load-bearing word, and it is why the pass stamps `lastCompleteRollupDay`
   * rather than the newest day it wrote. A pass folds the day it runs in as well, but that day
   * goes on accruing after the sweep returns, so reporting it would present the one bucket
   * guaranteed to be short as a finished one. The reader NEEDS the distinction: this rollup is
   * a day behind on the facade whose sweep is a daily cron, and a report served from it
   * without saying how far it reaches would render a missing day of spend as a cheap one.
   */
  spendRollupWatermark(): Promise<number | null>
  /**
   * Spend in `[range.since, range.until)` grouped by `dimension`, heaviest-first: the same
   * shape `ReportsRepository.spendByDimension` returns off the ledger, so the two are
   * interchangeable per window and the conformance suite asserts they agree.
   *
   * ONE `GROUP BY` over `spend_days` alone: every dimension it groups by, and every label it
   * renders, is a column on the row. `range` is matched on the bucket's `day_start`, so a
   * window starting mid-day includes that whole day; the report windows this serves are
   * snapped to a bucket edge that is always a UTC midnight.
   *
   * Scoped on the row's OWN denormalized `account_id` rather than through a `workspaces`
   * sub-select: a board deleted since the spend happened must not take its history's
   * attribution with it, which is the same reason every other dimension is frozen here.
   */
  spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]>
  /**
   * The window's rolled-up spend bucketed into `bucketMs`-wide slices, oldest first. Sparse
   * (empty buckets absent; the service zero-fills them). `bucketMs` is a whole number of days
   * on every window this serves, so a bucket never splits a rolled-up day.
   */
  spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]>
}
