import type {
  PlatformAlert,
  PlatformAlertReason,
  PlatformAlertSettings,
  PlatformAlertWindow,
  PlatformObservability,
} from '@cat-factory/contracts'

// Pure evaluation behind the platform-health ALERT sweep — the push counterpart to the pull
// dashboard. Given the SAME account-scoped `PlatformObservability` projection the dashboard
// renders and a set of operator thresholds, decide which alert conditions are firing. Kept
// pure (no clock, no I/O, no repos) so it is unit-tested directly and reused by both runtime
// facades' sweeps (Worker cron ⇄ Node interval) via the shared `sweepPlatformHealth` helper.
//
// Every condition reads a field that ALREADY exists on the projection — so the alert sweep
// needs NO new SQL, no port change, and no cross-store join (the "reuse the existing read"
// convention in the initiative tracker). Conditions that would need data the projection does
// not carry (e.g. "N runs stuck > 30min", which needs a per-run age query) are deliberately
// out of scope for this slice and noted in the tracker.

/**
 * The operator-configured ceilings a deployment's aggregate health is checked against. Each
 * maps to one {@link PlatformAlertReason}. Deployment-level config: the env vars set the
 * defaults at boot and an account's stored settings may override any of them per field
 * (see {@link resolveAccountAlertConfig}), NOT per-workspace.
 */
export interface PlatformAlertThresholds {
  /**
   * Minimum number of TERMINAL runs (done + failed) in the window before the failure-rate
   * alert can fire — so a single early failure (1/1 = 100%) on a quiet deployment doesn't page.
   */
  minRuns: number
  /** Run failure rate (0..1) at or above which `failure_rate_high` fires. */
  maxFailureRate: number
  /** p99 wall-clock run duration (ms) at or above which `duration_p99_high` fires. */
  maxP99DurationMs: number
  /** Live running/blocked/paused/pending depth at or above which `backlog_high` fires. */
  maxBacklog: number
  /**
   * How many TRAILING trend buckets must be completely empty before `throughput_stalled` can
   * fire. Expressed in buckets rather than hours so the condition scales with the configured
   * window: the projection buckets `1h` far more finely than `7d`, and a fixed hour count
   * would be a hair trigger on one and useless on the other.
   */
  stalledBuckets: number
  /**
   * Runs that must have been created in the EARLIER part of the same window before a stall
   * counts as one. Without it, a deployment that is merely idle overnight — genuinely nothing
   * to do — pages exactly like one that is wedged, and the alert gets muted, which costs the
   * signal on the night it matters.
   */
  minStalledPriorRuns: number
  /**
   * Share (0..1) of the window's failures that ONE kind must account for before
   * `failure_kind_dominant` fires. Gated by {@link minRuns} like the failure rate, so a
   * single early failure is never "100% evicted".
   */
  maxFailureKindShare: number
  /**
   * Consecutive failed passes of ONE sweeper before `sweep_degraded` fires. Counted by the
   * caller (the sweep observes its own history; this logic stays pure), so a transient
   * hiccup on a single tick is not an alert.
   */
  maxSweepFailures: number
}

/** Conservative defaults: quiet unless the deployment is genuinely unhealthy. */
export const DEFAULT_PLATFORM_ALERT_THRESHOLDS: PlatformAlertThresholds = {
  minRuns: 5,
  maxFailureRate: 0.5,
  maxP99DurationMs: 60 * 60_000, // 60 minutes
  maxBacklog: 50,
  // A quarter of a `1h` window's buckets (or of any other window's) with nothing at all,
  // against a window that was otherwise busy.
  stalledBuckets: 3,
  minStalledPriorRuns: 5,
  // Not 1.0: a deployment where 9 of 10 failures are evictions has the same incident as one
  // where 10 of 10 are, and a single stray `agent` failure should not silence it.
  maxFailureKindShare: 0.8,
  maxSweepFailures: 3,
}

/**
 * The alert configuration one account is actually evaluated under: the deployment's
 * env-derived defaults with that account's stored settings layered on top.
 */
export interface ResolvedAccountAlertConfig {
  /** Whether this account is alerted on at all. */
  enabled: boolean
  window: PlatformAlertWindow
  thresholds: PlatformAlertThresholds
}

/**
 * Layer an account's stored alert settings over the deployment defaults, field by field.
 *
 * ABSENT INHERITS; it never means zero. That is the whole contract of this function and the
 * reason it exists rather than a spread: a zero is a live, meaningful value in three of these
 * thresholds (`minStalledPriorRuns: 0` says "page even on an idle window"), so a merge that
 * treated a missing key and a stored `0` alike would turn "I did not set this" into the most
 * aggressive setting available, on every account that ever saved any unrelated field.
 *
 * `enabled` is deliberately a ONE-WAY switch: an account may mute itself, but cannot turn
 * alerting on where the deployment never started the sweep: there would be no timer to
 * honour it, and a stored `true` that does nothing is worse than an absent one.
 */
export function resolveAccountAlertConfig(
  deployment: {
    enabled: boolean
    window: PlatformAlertWindow
    thresholds: PlatformAlertThresholds
  },
  stored: PlatformAlertSettings | undefined,
): ResolvedAccountAlertConfig {
  const t = stored?.thresholds
  return {
    enabled: deployment.enabled && stored?.enabled !== false,
    window: stored?.window ?? deployment.window,
    thresholds: {
      minRuns: t?.minRuns ?? deployment.thresholds.minRuns,
      maxFailureRate: t?.maxFailureRate ?? deployment.thresholds.maxFailureRate,
      maxP99DurationMs: t?.maxP99DurationMs ?? deployment.thresholds.maxP99DurationMs,
      maxBacklog: t?.maxBacklog ?? deployment.thresholds.maxBacklog,
      stalledBuckets: t?.stalledBuckets ?? deployment.thresholds.stalledBuckets,
      minStalledPriorRuns: t?.minStalledPriorRuns ?? deployment.thresholds.minStalledPriorRuns,
      maxFailureKindShare: t?.maxFailureKindShare ?? deployment.thresholds.maxFailureKindShare,
      maxSweepFailures: t?.maxSweepFailures ?? deployment.thresholds.maxSweepFailures,
    },
  }
}

/**
 * The alert reasons whose evidence is a set of FAILED RUNS, so a card firing any of them can
 * deep-link to the runs it is aggregating. The other conditions are about depth, latency or
 * the absence of work, and have no failing run to point at. A link that resolved to nothing
 * would read as "there are no failures", which is the opposite of what a backlog or stall
 * alert is saying.
 */
const RUN_EVIDENCED_REASONS: ReadonlySet<PlatformAlertReason> = new Set<PlatformAlertReason>([
  'failure_rate_high',
  'failure_kind_dominant',
])

/** Whether a fired reason set has failing runs behind it worth linking to. */
export function alertsHaveRunEvidence(reasons: readonly PlatformAlertReason[]): boolean {
  return reasons.some((r) => RUN_EVIDENCED_REASONS.has(r))
}

/**
 * Evaluate one account's windowed projection against the thresholds, returning every fired
 * alert (empty when healthy). Each alert carries its observed value + the threshold it crossed
 * — used for the sweep's log line and any future detail surface. The NOTIFICATION card keys its
 * dedup on the reason SET only (see {@link platformAlertReasons}); the fluctuating values here
 * are intentionally not carried on the card (they'd re-toast the inbox every sweep).
 */
export function evaluatePlatformHealth(
  snapshot: PlatformObservability,
  thresholds: PlatformAlertThresholds,
  /**
   * The worst consecutive-failure streak across the deployment's sweepers, and which sweeper
   * it belongs to. Supplied by the CALLER because it is history rather than a property of the
   * snapshot — this function stays pure. Omitted ⇒ `sweep_degraded` cannot fire, which is the
   * right answer for a caller that does not track it rather than a claim that nothing failed.
   */
  sweepFailures?: { sweep: string; consecutive: number },
): PlatformAlert[] {
  const alerts: PlatformAlert[] = []
  const { outcomes, durations, live } = snapshot

  // Failure rate over terminal runs — gated by a minimum sample so a tiny window stays quiet.
  const terminal = outcomes.done + outcomes.failed
  if (terminal >= thresholds.minRuns && outcomes.successRate !== null) {
    const failureRate = 1 - outcomes.successRate
    if (failureRate >= thresholds.maxFailureRate) {
      alerts.push({
        reason: 'failure_rate_high',
        value: failureRate,
        threshold: thresholds.maxFailureRate,
      })
    }
  }

  // Slow-run tail: the p99 the average hides. Null (no terminal runs) → nothing to alert on.
  if (durations.p99Ms !== null && durations.p99Ms >= thresholds.maxP99DurationMs) {
    alerts.push({
      reason: 'duration_p99_high',
      value: durations.p99Ms,
      threshold: thresholds.maxP99DurationMs,
    })
  }

  // Live depth right now (a snapshot, not windowed): a growing backlog of unfinished runs.
  const backlog = live.running + live.blocked + live.paused + live.pending
  if (backlog >= thresholds.maxBacklog) {
    alerts.push({ reason: 'backlog_high', value: backlog, threshold: thresholds.maxBacklog })
  }

  // Throughput stalled: the deployment stopped taking work. Every condition above divides by
  // runs, so all three go quiet at `total = 0` — a fully dead platform reads identically to a
  // quiet healthy one. Read off the zero-filled trend rather than a second query: the tail
  // buckets say "nothing now", the head buckets say "there was something to do".
  const stalled = trailingStall(snapshot, thresholds)
  if (stalled !== null) {
    alerts.push({
      reason: 'throughput_stalled',
      value: stalled,
      threshold: thresholds.stalledBuckets,
    })
  }

  // One failure kind dominating. 100% `evicted` and 100% `agent` produce an identical
  // `failure_rate_high` and need opposite fixes (the container substrate versus the model), so
  // the concentration is its own condition rather than a detail on the dashboard.
  const totalFailures = snapshot.failures.reduce((sum, slice) => sum + slice.count, 0)
  if (terminal >= thresholds.minRuns && totalFailures > 0) {
    const dominant = Math.max(...snapshot.failures.map((slice) => slice.count))
    const share = dominant / totalFailures
    if (share >= thresholds.maxFailureKindShare) {
      alerts.push({
        reason: 'failure_kind_dominant',
        value: share,
        threshold: thresholds.maxFailureKindShare,
      })
    }
  }

  // The watcher itself. A sweeper that has failed every pass makes every signal above stale
  // WITHOUT making any of them fire — the stale-run sweeper stops recovering lost runs, the
  // retention sweep stops bounding the tables — so its own health is an alert condition.
  if (sweepFailures && sweepFailures.consecutive >= thresholds.maxSweepFailures) {
    alerts.push({
      reason: 'sweep_degraded',
      value: sweepFailures.consecutive,
      threshold: thresholds.maxSweepFailures,
    })
  }

  return alerts
}

/**
 * How many trailing trend buckets are completely empty, when that run of emptiness qualifies
 * as a STALL — or null when it does not. Two things have to hold, and the second is what keeps
 * this from paging every night:
 *
 *   - the last `stalledBuckets` buckets created no runs at all, and
 *   - the buckets BEFORE them created at least `minStalledPriorRuns`.
 *
 * An idle deployment fails the second test (its whole window is empty) and stays quiet; a
 * wedged one passes both, because the work it was doing is exactly what stopped. A window with
 * too few buckets to hold both halves cannot answer the question and returns null rather than
 * guessing — the honest answer for "not enough history".
 *
 * The number returned is the MEASURED run of empty buckets, not the threshold that qualified
 * it. Every other condition reports what it observed next to what it allows, and returning the
 * threshold here made a stall that had lasted all night indistinguishable on the card from one
 * that had just crossed the line — the platform is supposed to COMPUTE the magnitude.
 */
function trailingStall(
  snapshot: PlatformObservability,
  thresholds: PlatformAlertThresholds,
): number | null {
  const points = snapshot.trend.points
  const tail = thresholds.stalledBuckets
  // Both thresholds must be real numbers before this can answer anything. A partially-built
  // threshold bag (a caller that predates these fields) would otherwise slip past a `<= 0`
  // guard as `undefined` and fire the alert on an EMPTY trend — the one deployment shape where
  // there is least evidence of a stall. "Cannot evaluate" is null, like every other branch here.
  if (!Number.isFinite(tail) || !Number.isFinite(thresholds.minStalledPriorRuns)) return null
  if (tail <= 0 || points.length <= tail) return null
  const runsIn = (point: (typeof points)[number]) => point.done + point.failed + point.other
  const tailPoints = points.slice(-tail)
  if (tailPoints.some((point) => runsIn(point) > 0)) return null
  const prior = points.slice(0, -tail).reduce((sum, point) => sum + runsIn(point), 0)
  if (prior < thresholds.minStalledPriorRuns) return null
  // Qualified. Now measure how far back the silence ACTUALLY reaches, so the alert reports the
  // observed magnitude rather than the bar it cleared. Walk on past the tail while buckets stay
  // empty; `prior > 0` guarantees this terminates before consuming the whole series.
  let empty = tail
  while (empty < points.length && runsIn(points[points.length - 1 - empty]!) === 0) empty++
  return empty
}

/**
 * The SORTED set of reason codes from a list of fired alerts — the platform-health card's
 * stable dedup identity. Sorted so the card content is a pure function of WHICH conditions
 * fire (never their order), so the notification service re-delivers only when the firing set
 * changes rather than on every sweep.
 */
export function platformAlertReasons(alerts: PlatformAlert[]): PlatformAlertReason[] {
  return alerts.map((a) => a.reason).sort()
}

/** Human-readable (English) fragment per reason, used to compose the card body below. */
const REASON_PHRASE: Record<PlatformAlertReason, string> = {
  failure_rate_high: 'an elevated run failure rate',
  duration_p99_high: 'slow run durations (p99)',
  backlog_high: 'a growing backlog of unfinished runs',
  throughput_stalled: 'no new runs at all, after a busy period',
  failure_kind_dominant: 'nearly every failure sharing one cause',
  sweep_degraded: 'a background maintenance sweep failing repeatedly',
}

const WINDOW_PHRASE: Record<PlatformAlertWindow, string> = {
  '1h': 'the last hour',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
}

/**
 * The stable card title + body for a fired reason set — a pure function of the reasons + window
 * (no live numbers), so a re-raise with the same firing set produces byte-identical content and
 * is de-duplicated. The inbox renders this backend-composed (English) title/body directly, like
 * every other notification type; the machine-readable reason set travels on
 * `payload.platformAlerts` as the dedup identity and the seam for a future localized rendering
 * (the `usePipelineErrorToast` mapping pattern), not yet wired in the SPA.
 */
export function platformHealthCardContent(
  reasons: PlatformAlertReason[],
  window: PlatformAlertWindow,
): { title: string; body: string } {
  const phrases = reasons.map((r) => REASON_PHRASE[r])
  const list =
    phrases.length <= 1
      ? (phrases[0] ?? 'a health threshold was crossed')
      : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
  return {
    title: 'Platform health alert',
    body: `The deployment shows ${list} over ${WINDOW_PHRASE[window]}. Open the operator dashboard for detail.`,
  }
}
