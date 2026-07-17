import type {
  PlatformAlert,
  PlatformAlertReason,
  PlatformObservability,
  PlatformObservabilityWindow,
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
 * maps to one {@link PlatformAlertReason}. Deployment-level config (env-driven defaults today;
 * a settings surface is a later slice), NOT per-workspace.
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
}

/** Conservative defaults: quiet unless the deployment is genuinely unhealthy. */
export const DEFAULT_PLATFORM_ALERT_THRESHOLDS: PlatformAlertThresholds = {
  minRuns: 5,
  maxFailureRate: 0.5,
  maxP99DurationMs: 60 * 60_000, // 60 minutes
  maxBacklog: 50,
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

  return alerts
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

/** Human-readable (English) fragment per reason — the SPA localizes from `payload.platformAlerts`. */
const REASON_PHRASE: Record<PlatformAlertReason, string> = {
  failure_rate_high: 'an elevated run failure rate',
  duration_p99_high: 'slow run durations (p99)',
  backlog_high: 'a growing backlog of unfinished runs',
}

const WINDOW_PHRASE: Record<PlatformObservabilityWindow, string> = {
  '1h': 'the last hour',
  '24h': 'the last 24 hours',
  '7d': 'the last 7 days',
}

/**
 * The stable card title + body for a fired reason set — a pure function of the reasons + window
 * (no live numbers), so a re-raise with the same firing set produces byte-identical content and
 * is de-duplicated. English is the last-resort fallback the inbox shows; the SPA renders
 * localized copy from `payload.platformAlerts` (the `usePipelineErrorToast` mapping pattern).
 */
export function platformHealthCardContent(
  reasons: PlatformAlertReason[],
  window: PlatformObservabilityWindow,
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
