import type { ReportActivityDimension, ReportSpendDimension } from '@cat-factory/contracts'

// Cross-cutting usage-analytics port: the rollups behind the Reports view. Where
// `PlatformMetricsRepository` answers "is the deployment HEALTHY" (outcomes, failure
// taxonomy, latency), this answers "how is it being USED" — where the spend and the
// work actually go, sliced by model, agent kind, workspace, service, repository, task
// type, tracker ticket and run.
//
// Every method is ONE aggregate query. A breakdown is a single `GROUP BY` over the
// ledger (`token_usage`) or the run table (`agent_runs`), scoped to an account by the
// same `account_id` sub-select on `workspaces` the platform-metrics port uses — never
// "load the rows and reduce in JS" (the N+1/aggregate ban), and never one query per
// dimension value.
//
// Deliberately confined to the MAIN store: `token_usage`, `agent_runs`, `blocks`,
// `services`, `github_repos`, `tasks` and `workspaces` all live there on both runtimes,
// so a breakdown that resolves a call's service, repo, task type or ticket is a join,
// not a cross-database read. The telemetry store (`llm_call_metrics`) is a physically
// separate database on Cloudflare and is never joined here.
//
// No row cap HERE, on purpose, and that is a statement about this port rather than about
// what a reader receives. A SQL `LIMIT` would leave the store unable to say how much it
// dropped, and every caller folds its window totals out of one of these breakdowns, so a
// truncated aggregate would silently under-report the window. Returning everything grouped
// is what lets the caller cap with an exact count of the tail: `ReportsService.summarize`
// does that for the panel projection and `ReportsService.breakdown` for the public read.
//
// For most dimensions the choice costs nothing: the model catalog, the agent-kind catalog,
// an account's workspaces, its services, its repositories and the task-type picklist are all
// naturally bounded. `ticket` and `run` are NOT. Their cardinality is the number of distinct
// tracker issues, and of pipeline executions, that spent anything in the window, which grows
// with ACTIVITY rather than with a catalog, so a busy account over a 90-day window can group
// thousands of rows where the others group tens. Anything reading those two straight off this
// port and handing them to a client owes its reader a cap that says what it left out.

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

/**
 * One slice of an activity breakdown, aggregated from the runs CREATED in the window.
 *
 * Sliceable by board, service, REPOSITORY and task type. The repository axis is not derivable
 * from the service one: several services legitimately point at a single repository (the
 * monorepo case), and no read publishes the service-to-repository map, so folding service
 * counts up to a repository is not something a caller can do for itself.
 *
 * Spans EVERY `agent_runs` kind (`execution`, `bootstrap`, `env-config-repair`), deliberately
 * and unlike `PlatformMetricsRepository`, which groups by kind because its question is about
 * run health. Here the activity breakdowns sit beside the spend breakdowns on the same
 * dimension, and spend is the ledger of calls those same runs made — a bootstrap run's LLM
 * calls are in `token_usage` like any other. Filtering activity to `execution` alone would
 * put the two halves of one row on different populations, so a board could show more spend
 * than it had runs to explain. The cost is that a bootstrap run, which carries no block and
 * usually no service, lands in the `''` (unattributed) slice of the `service` and `taskType`
 * breakdowns — where it belongs, since there is genuinely nothing to attribute it to.
 */
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
