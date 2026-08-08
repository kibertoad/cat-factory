import type {
  ReportSpendDimension,
  ReportSpendRow,
  ReportSpendSource,
  ReportTotals,
  ReportWindow,
  ReportsView,
} from '@cat-factory/contracts'
import type {
  Clock,
  ReportRange,
  ReportScope,
  ReportSpendGroup,
  ReportSpendTrendBucket,
  ReportsRepository,
  SpendRollupRepository,
} from '@cat-factory/kernel'
import {
  REPORT_WINDOWS,
  alignWindowStart,
  buildSpendTrend,
  foldTotals,
  toActivityRow,
  toSpendRow,
} from './reports.logic.js'

/** The spend half of a window, from whichever store the window routes to. */
interface SpendSource {
  byDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]>
  trend(scope: ReportScope, range: ReportRange, bucketMs: number): Promise<ReportSpendTrendBucket[]>
  /** The sweep's coverage, on the rollup path; null on the ledger path (nothing to be behind). */
  watermark(): Promise<number | null>
}

/**
 * One dimension's spend over a window, with the window's own facts beside it: which store
 * answered, how far its sweep has covered, and the span the numbers cover.
 *
 * Deliberately NOT the wire shape of any surface that serves it. The public API projects this
 * into its own frozen resource, exactly as it does for the usage breakdown, so an internal
 * analytics shape stays free to change.
 */
export interface ReportsBreakdown {
  dimension: ReportSpendDimension
  window: ReportWindow
  generatedAt: number
  since: number
  currency: string
  source: ReportSpendSource
  rolledUpThrough: number | null
  /** Over the window's WHOLE population, never only the rows returned beside it. */
  totals: ReportTotals
  /** The heaviest slices by metered cost, capped by the caller's `limit` when it named one. */
  rows: ReportSpendRow[]
  /** True when the window held more slices than `limit`, so `rows` is a prefix of them. */
  truncated: boolean
}

export interface ReportsServiceDependencies {
  reportsRepository: ReportsRepository
  /**
   * The durable cost-attribution rollup, which serves the long windows. Optional so a facade
   * that has not wired it (or a unit test) falls back to the ledger for every window rather
   * than losing the two long ones: the ledger holds ~13 months, so the fallback is accurate
   * until retention reaches it, and the projection still SAYS `ledger` so nothing reads as
   * durable that is not.
   */
  spendRollupRepository?: SpendRollupRepository
  clock: Clock
  /**
   * The deployment's spend currency (the base pricing table's), so the SPA formats every
   * cost without a second call. Deliberately the BASE currency and not a workspace's
   * override: an account-wide report spans boards that may each override it, and summing
   * differently-denominated costs into one number would be wrong.
   */
  currency: string
}

/**
 * Cross-cutting usage analytics: composes the rollups behind {@link ReportsRepository} and
 * {@link SpendRollupRepository} into the Reports view: spend sliced by model, agent kind,
 * repository, tracker ticket and run, spend and run activity sliced by workspace / service /
 * task type, and a spend trend, over a time window. Run, repository and ticket are the TCO
 * axes: what an organisation budgets against, answered by a grouped query rather than a
 * hand-written join against the database.
 *
 * The dual of {@link PlatformObservabilityService}: that answers "is the deployment
 * healthy", this answers "where are the money and the work going". Every breakdown is one
 * SQL GROUP BY, and they are independent aggregates run in parallel — NOT an N+1. The
 * reshaping (totals fold, trend zero-fill) is the pure logic in `reports.logic.ts`.
 *
 * Two stores answer the spend half, routed by window exactly as the operator dashboard routes
 * its own: `24h`/`7d` scan the `token_usage` ledger live, `30d`/`90d` read the durable
 * `spend_days` rollup, which carries each run's board shape frozen at spend time and is never
 * pruned. The projection reports which answered (`source`) and, on the rollup path, how far
 * the sweep has covered (`rolledUpThrough`), because an un-materialised rollup and an idle
 * quarter produce the same empty breakdown and are opposite facts.
 */
export class ReportsService {
  constructor(private readonly deps: ReportsServiceDependencies) {}

  async summarize(
    accountId: string,
    window: ReportWindow,
    workspaceId?: string | null,
  ): Promise<ReportsView> {
    const { windowMs, bucketMs, source: preferred } = REPORT_WINDOWS[window]
    const until = this.deps.clock.now()
    // Snapped to a bucket edge so the trend's leading column is a COMPLETE bucket; every
    // breakdown and the totals aggregate over the same snapped window, so the tiles and the
    // chart can never describe different spans. It is also what keeps a rollup-backed window
    // on whole UTC days. See `alignWindowStart`.
    const since = alignWindowStart(until, windowMs, bucketMs)
    const scope: ReportScope = { accountId, workspaceId: workspaceId ?? null }
    const range: ReportRange = { since, until }
    const repo = this.deps.reportsRepository
    const { source, spend } = this.spendSource(preferred)
    const [
      byModel,
      byAgentKind,
      spendByWorkspace,
      spendByService,
      spendByRepo,
      spendByTaskType,
      spendByTicket,
      spendByRun,
      activityByWorkspace,
      activityByService,
      activityByTaskType,
      trend,
      rolledUpThrough,
    ] = await Promise.all([
      spend.byDimension(scope, 'model', range),
      spend.byDimension(scope, 'agentKind', range),
      spend.byDimension(scope, 'workspace', range),
      spend.byDimension(scope, 'service', range),
      spend.byDimension(scope, 'repo', range),
      spend.byDimension(scope, 'taskType', range),
      spend.byDimension(scope, 'ticket', range),
      spend.byDimension(scope, 'run', range),
      repo.activityByDimension(scope, 'workspace', range),
      repo.activityByDimension(scope, 'service', range),
      repo.activityByDimension(scope, 'taskType', range),
      spend.trend(scope, range, bucketMs),
      spend.watermark(),
    ])
    const spendByModel = byModel.map(toSpendRow)
    return {
      window,
      generatedAt: until,
      since,
      workspaceId: workspaceId ?? null,
      currency: this.deps.currency,
      source,
      rolledUpThrough,
      // Every spend breakdown partitions the same rows, so the totals fold from
      // whichever one is at hand rather than costing another query.
      totals: foldTotals(spendByModel),
      spend: {
        byModel: spendByModel,
        byAgentKind: byAgentKind.map(toSpendRow),
        byWorkspace: spendByWorkspace.map(toSpendRow),
        byService: spendByService.map(toSpendRow),
        byRepo: spendByRepo.map(toSpendRow),
        byTaskType: spendByTaskType.map(toSpendRow),
        byTicket: spendByTicket.map(toSpendRow),
        byRun: spendByRun.map(toSpendRow),
      },
      activity: {
        byWorkspace: activityByWorkspace.map(toActivityRow),
        byService: activityByService.map(toActivityRow),
        byTaskType: activityByTaskType.map(toActivityRow),
      },
      trend: { bucketMs, points: buildSpendTrend(trend, since, until, bucketMs) },
    }
  }

  /**
   * ONE spend dimension over the same window routing {@link ReportsService.summarize} uses:
   * what the public `GET /api/v1/usage/spend` serves, and what a caller asking a single
   * question (what did this repository cost, what did that ticket cost) actually needs.
   *
   * A separate method rather than a `dimension` option on `summarize`, because the two differ
   * in what they COST: the panel renders every slice together and pays for eleven aggregates,
   * where this is one `GROUP BY` and returning the other ten would be work nobody asked for.
   * Everything else about it is deliberately the same read, so a number here and the same
   * number in the panel come from one code path.
   *
   * `limit` bounds what is RETURNED, not what is aggregated: `totals` folds the window's whole
   * population either way, so a capped breakdown still reports what was spent and only loses
   * the identity of the tail. That is why the cap is applied here rather than pushed into the
   * `GROUP BY` as a SQL `LIMIT`, which would take the totals down with it.
   */
  async breakdown(
    accountId: string,
    dimension: ReportSpendDimension,
    window: ReportWindow,
    workspaceId?: string | null,
    limit?: number,
  ): Promise<ReportsBreakdown> {
    const { windowMs, bucketMs, source: preferred } = REPORT_WINDOWS[window]
    const until = this.deps.clock.now()
    // The same snapped start the panel aggregates over, so a slice read here and the same
    // slice read there cover the identical span rather than differing by a partial bucket.
    const since = alignWindowStart(until, windowMs, bucketMs)
    const { source, spend } = this.spendSource(preferred)
    const [groups, rolledUpThrough] = await Promise.all([
      spend.byDimension({ accountId, workspaceId: workspaceId ?? null }, dimension, {
        since,
        until,
      }),
      spend.watermark(),
    ])
    const rows = groups.map(toSpendRow)
    return {
      dimension,
      window,
      generatedAt: until,
      since,
      currency: this.deps.currency,
      source,
      rolledUpThrough,
      // Folded from ALL the rows rather than queried again: this breakdown partitions the
      // window's whole ledger, so the two cannot disagree by construction. Folded BEFORE the
      // cap for the same reason: a total over the returned prefix would under-report the
      // window while still reading as the window's total.
      totals: foldTotals(rows),
      truncated: limit !== undefined && rows.length > limit,
      rows: limit !== undefined ? rows.slice(0, limit) : rows,
    }
  }

  /**
   * Bind the window's spend reads to the store that serves them, and report which one that
   * turned out to be. The window PREFERS the rollup on the long windows; an unwired rollup
   * repository degrades to the ledger, and the returned `source` says so rather than
   * labelling ledger numbers as durable ones.
   */
  private spendSource(preferred: ReportSpendSource): {
    source: ReportSpendSource
    spend: SpendSource
  } {
    const rollup = this.deps.spendRollupRepository
    if (preferred === 'daily-rollup' && rollup) {
      return {
        source: 'daily-rollup',
        spend: {
          byDimension: (scope, dimension, range) =>
            rollup.spendByDimension(scope, dimension, range),
          trend: (scope, range, bucketMs) => rollup.spendTrend(scope, range, bucketMs),
          watermark: () => rollup.spendRollupWatermark(),
        },
      }
    }
    const repo = this.deps.reportsRepository
    return {
      source: 'ledger',
      spend: {
        byDimension: (scope, dimension, range) => repo.spendByDimension(scope, dimension, range),
        trend: (scope, range, bucketMs) => repo.spendTrend(scope, range, bucketMs),
        // Null, not a stale watermark: there is no rollup in this path, so there is nothing
        // about it that could be behind, and reporting one would invite the reader to believe
        // the ledger numbers were bounded by it.
        watermark: () => Promise.resolve(null),
      },
    }
  }
}
