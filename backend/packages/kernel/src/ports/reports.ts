import type { ReportActivityDimension, ReportSpendDimension } from '@cat-factory/contracts'

// Cross-cutting usage-analytics port: the rollups behind the Reports view. Where
// `PlatformMetricsRepository` answers "is the deployment HEALTHY" (outcomes, failure
// taxonomy, latency), this answers "how is it being USED" — where the spend and the
// work actually go, sliced by model, agent kind, workspace, service and task type.
//
// Every method is ONE aggregate query. A breakdown is a single `GROUP BY` over the
// ledger (`token_usage`) or the run table (`agent_runs`), scoped to an account by the
// same `account_id` sub-select on `workspaces` the platform-metrics port uses — never
// "load the rows and reduce in JS" (the N+1/aggregate ban), and never one query per
// dimension value.
//
// Deliberately confined to the MAIN store: `token_usage`, `agent_runs`, `blocks`,
// `services` and `workspaces` all live there on both runtimes, so a breakdown that
// resolves a call's service or task type is a join, not a cross-database read. The
// telemetry store (`llm_call_metrics`) is a physically separate database on
// Cloudflare and is never joined here.
//
// No row cap, on purpose. Every dimension has naturally bounded cardinality — the
// model catalog, the agent-kind catalog, an account's workspaces, its services, the
// task-type picklist — so a breakdown cannot grow unbounded, and capping would either
// silently drop slices or make the folded totals disagree with the rows.

/** Which rows a report aggregates: an account, optionally narrowed to one of its boards. */
export interface ReportScope {
  accountId: string
  /** Narrow every breakdown to a single workspace; null/undefined ⇒ the whole account. */
  workspaceId?: string | null
}

/** The half-open window `[since, until)` a report aggregates over (epoch ms). */
export interface ReportRange {
  since: number
  until: number
}

/**
 * One slice of a spend breakdown, aggregated from `token_usage`.
 *
 * `key` is the raw dimension value and the slice's identity; the EMPTY string is a real
 * bucket meaning unattributed (a call whose run, service or task type could not be
 * resolved), never a dropped row. `label` is a resolved display name when the store can
 * join one (the workspace's name, the service's frame title) and null otherwise — the
 * remaining dimensions are self-describing.
 *
 * The two cost columns are separate because only `meteredCost` is real money:
 * `subscriptionCost` is the illustrative equivalent-API cost of flat-rate quota usage,
 * which the spend gate deliberately excludes. Summing them yields a number that means
 * nothing; a caller that wants "spend" wants `meteredCost`.
 */
export interface ReportSpendGroup {
  key: string
  label: string | null
  inputTokens: number
  outputTokens: number
  calls: number
  meteredCost: number
  subscriptionCost: number
}

/** One slice of an activity breakdown, aggregated from the runs CREATED in the window. */
export interface ReportActivityGroup {
  key: string
  label: string | null
  runs: number
  done: number
  failed: number
  running: number
  /** Every status that is neither terminal nor `running` (`blocked`/`paused`/`pending`). */
  other: number
  /** Mean `updated_at - created_at` over this slice's terminal runs (ms); null when none. */
  avgDurationMs: number | null
}

/** One populated time bucket of the spend trend. Sparse — empty buckets are simply absent. */
export interface ReportSpendTrendBucket {
  /** Epoch-ms start of the bucket (a multiple of the bucket width). */
  bucketStart: number
  meteredCost: number
  subscriptionCost: number
  calls: number
  inputTokens: number
  outputTokens: number
}

export interface ReportsRepository {
  /**
   * Metered + subscription usage in `[range.since, range.until)`, grouped by `dimension`
   * and ordered heaviest-first (by total cost). One `GROUP BY` over `token_usage`; the
   * `service` and `taskType` dimensions reach the run's service/block through a join on
   * `execution_id`, so a call with no resolvable run lands in the `''` bucket.
   */
  spendByDimension(
    scope: ReportScope,
    dimension: ReportSpendDimension,
    range: ReportRange,
  ): Promise<ReportSpendGroup[]>
  /**
   * Runs CREATED in `[range.since, range.until)`, grouped by `dimension` and ordered
   * busiest-first. One `GROUP BY` over `agent_runs` with the status splits and the
   * terminal-run mean duration as conditional aggregates in the SAME pass (never a
   * second scan to add the average).
   */
  activityByDimension(
    scope: ReportScope,
    dimension: ReportActivityDimension,
    range: ReportRange,
  ): Promise<ReportActivityGroup[]>
  /**
   * The window's usage bucketed into `bucketMs`-wide time slices, oldest first. Sparse
   * (empty buckets are absent); the service zero-fills them into a contiguous series.
   */
  spendTrend(
    scope: ReportScope,
    range: ReportRange,
    bucketMs: number,
  ): Promise<ReportSpendTrendBucket[]>
}
