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
}
