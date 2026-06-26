import type { CiCheck } from '../ports/ci-status.js'
import type {
  ReleaseEvidence,
  ReleaseHealthReport,
  ReleaseSignal,
} from '../ports/release-health.js'

// Pure gate logic + the gate/helper agent-kind constants, shared by the built-in gate
// suite (`@cat-factory/gates`) and the engine. Lives in kernel (not orchestration) so a
// gate package can author a full polling gate — `probe()` classification, helper
// escalation, notification copy — depending only on kernel, never on the engine. Pure:
// every function here is a deterministic reduction over its inputs (kernel types only),
// so it is trivially unit-testable and runtime-neutral.

// --- Gate + helper agent-kind constants -----------------------------------------------

/** The agent kind of the special CI-gate step (polls checks, loops the ci-fixer). */
export const CI_AGENT_KIND = 'ci'

/** The agent kind of the container agent that fixes failing CI on the PR branch. */
export const CI_FIXER_AGENT_KIND = 'ci-fixer'

/**
 * The agent kind of the special pre-merge gate step: it checks whether the PR can
 * be merged and, on a conflict, loops the conflict-resolver — mirroring the CI gate.
 */
export const CONFLICTS_AGENT_KIND = 'conflicts'

/**
 * The agent kind of the container agent that resolves merge conflicts: it merges
 * the base into the PR branch, fixes the conflicts and pushes back onto the branch.
 */
export const CONFLICT_RESOLVER_AGENT_KIND = 'conflict-resolver'

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

// --- CI verdict logic -----------------------------------------------------------------

/**
 * The aggregate CI verdict for a PR head commit, derived from its check runs:
 *  - `none`    — no checks reported (nothing to gate; treated as green).
 *  - `pending` — at least one check is still queued/in-progress and none failed.
 *  - `success` — every completed check succeeded (or was neutral/skipped) and none pending.
 *  - `failure` — at least one check concluded in a non-success terminal state.
 */
export type CiVerdict = 'none' | 'pending' | 'success' | 'failure'

/** Conclusions GitHub reports for a *completed* check that are NOT failures. */
const PASSING_CONCLUSIONS = new Set(['success', 'neutral', 'skipped'])

/**
 * Reduce a set of check runs to a single verdict. A failure dominates (one red
 * check fails the gate); otherwise a still-running check keeps it pending; with
 * everything completed-and-passing it is green; with no checks at all it is
 * `none` (the engine treats `none` as green so a repo with no CI configured isn't
 * blocked forever).
 */
export function aggregateCi(checks: CiCheck[]): CiVerdict {
  if (checks.length === 0) return 'none'
  let pending = false
  for (const check of checks) {
    if (check.status !== 'completed') {
      pending = true
      continue
    }
    const conclusion = check.conclusion ?? ''
    if (!PASSING_CONCLUSIONS.has(conclusion)) return 'failure'
  }
  return pending ? 'pending' : 'success'
}

/** Whether a verdict means the gate may advance (green or nothing to gate). */
export function isCiGreen(verdict: CiVerdict): boolean {
  return verdict === 'success' || verdict === 'none'
}

/** The completed-and-non-passing checks behind a `failure` verdict. */
export function listFailingChecks(
  checks: CiCheck[],
): { name: string; conclusion: string | null; url: string | null }[] {
  return checks
    .filter((c) => c.status === 'completed' && !PASSING_CONCLUSIONS.has(c.conclusion ?? ''))
    .map((c) => ({ name: c.name, conclusion: c.conclusion, url: c.url ?? null }))
}

/** A short, human-readable summary of the failing checks, for the step output / notification. */
export function describeFailingChecks(checks: CiCheck[]): string {
  const failing = listFailingChecks(checks)
  if (failing.length === 0) return 'CI reported a failure.'
  const names = failing.map((c) => `${c.name} (${c.conclusion ?? 'failure'})`).join(', ')
  return `Failing checks: ${names}`
}

// --- Release-health verdict logic -----------------------------------------------------

/** The gate verdict for one post-release-health probe. */
export type ReleaseGateVerdict = 'pass' | 'pending' | 'fail'

/**
 * Decide the gate verdict from the provider's signal verdict + the monitoring-window
 * timing:
 *  - `regressed`                       → `fail` (escalate to the on-call agent).
 *  - anything else & window not elapsed → `pending` (keep watching the rest of the window).
 *  - anything else & window elapsed     → `pass` (no regression observed in the window).
 *
 * The non-regressed states (`healthy` AND `pending`/`no_data`) are treated the same way:
 * keep watching until the window elapses, then pass. This is deliberate — a `pending`
 * verdict means "no regression detected yet" (e.g. a quiet or `no_data` monitor right
 * after deploy), NOT "broken". Blocking advancement on it forever (the old behaviour)
 * meant a permanently-`no_data` monitor burned the whole poll budget and then failed an
 * otherwise-healthy release as a false `timeout`. The window is the grace period; once it
 * elapses with nothing alerting, the release ships.
 *
 * `warn` states do not regress the gate — only `alert`/SLO-breach (which the provider
 * maps to `regressed`) do — so a warning threshold doesn't pause the pipeline.
 */
export function classifyReleaseHealth(args: {
  report: ReleaseHealthReport
  windowElapsed: boolean
}): ReleaseGateVerdict {
  if (args.report.status === 'regressed') return 'fail'
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

/**
 * Render the on-call evidence bundle (regressed signals + recent errors + notes) into the
 * prompt the `on-call` agent investigates. Pure (same evidence → same bytes); the engine
 * hands the result to the agent via the gate's `gatherHelperPriorOutputs`.
 */
export function renderReleaseEvidence(evidence: ReleaseEvidence): string {
  const lines: string[] = ['## Post-release regression evidence', '']
  if (evidence.regressedSignals.length > 0) {
    lines.push('Regressed signals:')
    for (const s of evidence.regressedSignals) {
      lines.push(`- ${s.kind} "${s.name}" (${s.id}): ${s.state}${s.detail ? ` — ${s.detail}` : ''}`)
    }
    lines.push('')
  }
  if (evidence.errors.length > 0) {
    lines.push('Recent errors:')
    for (const e of evidence.errors) {
      lines.push(
        `- ${e.title}${e.count != null ? ` ×${e.count}` : ''}${e.sampleMessage ? ` — ${e.sampleMessage}` : ''}`,
      )
    }
    lines.push('')
  }
  if (evidence.notes) lines.push(evidence.notes, '')
  lines.push(
    'Investigate whether THIS PR is the likely cause: correlate its diff with the regressed ' +
      'signals and errors above (and the service logs). Beware correlation ≠ causation. Return a ' +
      'JSON assessment: { "culpritConfidence": 0..1, "recommendation": "revert"|"hold"|"monitor", ' +
      '"rationale": "…", "evidence": ["…"] }. Do NOT make commits or revert anything — a human decides.',
  )
  return lines.join('\n')
}
