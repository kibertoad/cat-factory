import type { ReleaseHealthReport, ReleaseSignal } from '@cat-factory/kernel'

/**
 * The agent kind of the special post-release-health gate step. Like `ci`/`conflicts`
 * it is NOT a container/inline LLM agent: it polls a `ReleaseHealthProvider` (Datadog
 * monitors/SLOs) over a monitoring window after deploy and only escalates to the
 * `on-call` agent on a regression. Passes through when no provider/config is wired.
 */
export const POST_RELEASE_HEALTH_AGENT_KIND = 'post-release-health'

/**
 * The agent kind of the `on-call` container agent dispatched on a release regression.
 * It clones the released PR head, reasons over the evidence bundle (alerting
 * monitors/SLOs + recent error logs) against the diff, and returns a JSON assessment
 * (culprit confidence + recommendation). It makes NO commits and reverts nothing —
 * the engine raises a `release_regression` notification for a human to decide.
 */
export const ON_CALL_AGENT_KIND = 'on-call'

/** The gate verdict for one post-release-health probe. */
export type ReleaseGateVerdict = 'pass' | 'pending' | 'fail'

/**
 * Decide the gate verdict from the provider's signal verdict + the monitoring-window
 * timing:
 *  - `regressed`                     → `fail` (escalate to the on-call agent).
 *  - `pending` (no verdict yet)      → `pending` (keep watching).
 *  - `healthy` & window elapsed      → `pass` (the release looks good; advance).
 *  - `healthy` & window not elapsed  → `pending` (keep watching the rest of the window).
 *
 * `warn` states do not regress the gate — only `alert`/SLO-breach (which the provider
 * maps to `regressed`) do — so a warning threshold doesn't pause the pipeline.
 */
export function classifyReleaseHealth(args: {
  report: ReleaseHealthReport
  windowElapsed: boolean
}): ReleaseGateVerdict {
  if (args.report.status === 'regressed') return 'fail'
  if (args.report.status === 'pending') return 'pending'
  return args.windowElapsed ? 'pass' : 'pending'
}

/** A short, human-readable summary of the regressed signals, for the notification + on-call. */
export function describeRegressedSignals(signals: ReleaseSignal[]): string {
  const bad = signals.filter((s) => s.state === 'alert')
  if (bad.length === 0) return 'A monitored release signal regressed.'
  const names = bad
    .map((s) => `${s.name} (${s.state}${s.detail ? `: ${s.detail}` : ''})`)
    .join(', ')
  return `Regressed signals: ${names}`
}
