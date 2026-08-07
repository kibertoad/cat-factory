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
   * The pass also records its coverage under {@link SPEND_DAYS_ROLLUP} in the same
   * transaction, forward-only, so {@link spendRollupWatermark} describes the rows that exist.
   */
  rollupSpendDays(fromEpochMs: number, toEpochMs: number): Promise<number>
  /**
   * The newest UTC day the rollup SWEEP has covered (epoch ms, midnight), or null when no pass
   * has ever completed. Read from the sweep's own recorded coverage, deployment-scoped, for
   * the reasons on `PlatformMetricsRepository.dailyRollupWatermark`.
   *
   * The reader NEEDS it: this rollup is a day behind on the facade whose sweep is a daily
   * cron, so a report served from it without saying how far it reaches would present a missing
   * day of spend as a cheap one.
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
