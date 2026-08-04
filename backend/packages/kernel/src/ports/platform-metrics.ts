import type { AgentRunKind } from '../domain/types.js'

// Deployment-level (platform-operator) observability port. Where the per-run
// `LlmCallMetricRepository` answers "what did THIS run do", this port answers "how
// is the WHOLE deployment doing" — run success/failure rates, failure taxonomy,
// throughput/duration trends, and live queue/park depth. Every method is ONE
// `GROUP BY`/aggregate query over the `agent_runs` table (both run kinds), scoped
// to a single account by an `account_id` sub-select on `workspaces` — never a
// "load all rows and reduce in JS" (the N+1/aggregate ban).
//
// Deliberately confined to the MAIN store: outcome, failure kind and timing all
// live on `agent_runs` (`status` + the JSON `failure` column + `created_at`/
// `updated_at`). It never joins the telemetry store (`llm_call_metrics`), which is
// a physically separate database on Cloudflare — token/cost rollups that need it
// are a later slice with its own store-local port.

/** One `(kind, status)` bucket of runs created in the window. */
export interface PlatformRunOutcome {
  kind: AgentRunKind
  /** The run's `agent_runs.status` (`running`/`blocked`/`done`/`paused`/`failed`/`pending`). */
  status: string
  count: number
}

/** One time-bucket of runs created in the window, split by status, for the trend sparkline. */
export interface PlatformRunTrendPoint {
  /** Epoch-ms start of the bucket (a multiple of the bucket width). */
  bucketStart: number
  status: string
  count: number
}

/** One failure-kind bucket of the FAILED runs created in the window. */
export interface PlatformFailureCount {
  /** The `failure.kind` (e.g. `evicted`/`timeout`/`agent`), or `unknown` when absent. */
  failureKind: string
  count: number
}

/** A snapshot (not windowed) of runs currently occupying the system, by lifecycle state. */
export interface PlatformLiveCounts {
  running: number
  blocked: number
  paused: number
  pending: number
}

/** Wall-clock duration stats over the TERMINAL runs (`done`/`failed`) created in the window. */
export interface PlatformDurationStats {
  count: number
  /** Rounded mean of `updated_at - created_at` (ms), or null when no terminal runs. */
  avgMs: number | null
  minMs: number | null
  maxMs: number | null
  /**
   * Discrete (nearest-rank) duration percentiles (ms), or null when no terminal runs. Both
   * facades compute the SAME nearest-rank value: Postgres via `percentile_disc`, SQLite via
   * the `row_number()/count()` cumulative-fraction order-statistic workaround (D1/SQLite has
   * no percentile aggregate) — the conformance suite pins that the two agree. `p50Ms` is the
   * median; the tail percentiles surface slow-run outliers the average hides.
   */
  p50Ms: number | null
  p90Ms: number | null
  p99Ms: number | null
}

/**
 * One `(day, status, failureKind)` bucket of the DAILY ROLLUP table: the pre-aggregated
 * counterpart of {@link PlatformRunOutcome} + {@link PlatformRunTrendPoint} +
 * {@link PlatformFailureCount}, which is why a single row shape serves all three folds.
 */
export interface PlatformDailyRunCount {
  /** UTC-midnight epoch-ms start of the day. */
  dayStart: number
  status: string
  /** The `failure.kind` for a `failed` row (`unknown` when absent); null for every other status. */
  failureKind: string | null
  count: number
}

/** One failed run behind an alert, for the notification card's deep-link. */
export interface PlatformFailedRunRef {
  workspaceId: string
  executionId: string
  blockId: string | null
  failureKind: string
  createdAt: number
  /**
   * How many runs failed in that WORKSPACE's window in total: the denominator the capped
   * sample is a sample OF. Carried on each row (a window function over the same partition)
   * rather than fetched separately, so the cap can state what it dropped without a second
   * query, and so the total can never disagree with the sample it accompanies.
   */
  workspaceFailedTotal: number
}

/**
 * The `platform_rollup_state.rollup` key the daily run rollup records its coverage under. One
 * constant so the two facades cannot write and read different keys, which would present a
 * perfectly healthy sweep as one that has never run.
 */
export const RUN_DAYS_ROLLUP = 'run_days'

export interface PlatformMetricsRepository {
  /**
   * Runs CREATED at or after `sinceEpochMs`, grouped by `(kind, status)`, for the
   * account's workspaces. The service reduces this into the outcome totals + success rate.
   */
  runOutcomesSince(accountId: string, sinceEpochMs: number): Promise<PlatformRunOutcome[]>
  /**
   * The same window bucketed into `bucketMs`-wide time slices (grouped by
   * `(bucketStart, status)`), for the outcome trend. Sparse — empty buckets are
   * absent and the service zero-fills them into a contiguous series.
   */
  runOutcomeTrend(
    accountId: string,
    sinceEpochMs: number,
    bucketMs: number,
  ): Promise<PlatformRunTrendPoint[]>
  /**
   * FAILED runs created in the window, grouped by their `failure.kind` (the JSON column,
   * `unknown` when unset). The failure taxonomy behind the dashboard's breakdown.
   */
  failureKindBreakdown(accountId: string, sinceEpochMs: number): Promise<PlatformFailureCount[]>
  /**
   * The account's CURRENT live/parked run counts (not windowed): how many runs are
   * `running`, `blocked`, `paused`, or `pending` right now — the queue/park depth.
   */
  activeAndParkedCounts(accountId: string): Promise<PlatformLiveCounts>
  /**
   * Wall-clock duration stats over terminal runs created in the window: count, avg/min/max,
   * and the discrete p50/p90/p99 percentiles — all over the SAME filtered row set in ONE
   * aggregate query (never a second scan to add the percentiles).
   */
  durationStatsSince(accountId: string, sinceEpochMs: number): Promise<PlatformDurationStats>
  /**
   * Materialise the DAILY ROLLUP for every day overlapping `[fromEpochMs, toEpochMs)`, as one
   * `INSERT … SELECT … GROUP BY` per runtime, never a read-into-JS-and-write-back. Returns
   * the number of rolled-up buckets written.
   *
   * IDEMPOTENT by construction: each day is recomputed from `agent_runs` and REPLACES the
   * stored bucket, so re-running the window is free, a sweep that missed passes self-heals by
   * widening nothing, and the current (still-accruing) day is corrected on every pass rather
   * than frozen at whatever it held when it was first written. That is also why the rollup
   * cannot be an append: a day's counts are not final until the day is over, and the
   * "published values must be final" rule applies to a bucket the reader treats as complete.
   */
  rollupRunDays(fromEpochMs: number, toEpochMs: number): Promise<number>
  /**
   * The account's rolled-up daily buckets at or after `sinceEpochMs`: the long-window
   * (`30d`/`90d`) source for the outcome totals, the trend AND the failure taxonomy, all of
   * which fold from this one read.
   */
  dailyRunTotalsSince(accountId: string, sinceEpochMs: number): Promise<PlatformDailyRunCount[]>
  /**
   * The newest day the rollup SWEEP has covered (epoch ms, UTC midnight), or null when no pass
   * has ever completed.
   *
   * Read from the sweep's own recorded coverage, NOT `max(dayStart)` over the rows above, and
   * DEPLOYMENT-scoped rather than per account. Both of those are the same point: the question is
   * about the SWEEP and the rows are about the RUNS. An account idle for a fortnight and a
   * wedged pass produce the same newest row; an account created yesterday and a rollup that has
   * never run produce the same absence. Deriving the watermark from data therefore answers a
   * different question than the one the dashboard asks, and answers it in a way that reads as
   * confident. The pass records what it covered, so null means "no pass has run" and a value
   * means "covered through here" whether or not anything happened in between.
   */
  dailyRollupWatermark(): Promise<number | null>
  /** Prune rolled-up daily buckets older than `cutoff` (epoch ms). Returns rows removed. */
  deleteRunDaysOlderThan(cutoff: number): Promise<number>
  /**
   * The most recent FAILED execution runs in the window, at most `perWorkspaceLimit` per
   * workspace, for the account: the evidence a `platform_health` card deep-links to.
   *
   * Capped PER WORKSPACE by a window function rather than by one global `LIMIT`, so a single
   * noisy workspace cannot starve every other one's card of its own evidence, and each row
   * carries its workspace's full failed count so the cap can report what it left out. Scoped
   * to `execution` runs because those are the ones a card can open; a bootstrap failure has
   * no run window to link to, and a link that lands nowhere is worse than no link.
   */
  recentFailedRuns(
    accountId: string,
    sinceEpochMs: number,
    perWorkspaceLimit: number,
  ): Promise<PlatformFailedRunRef[]>
}
