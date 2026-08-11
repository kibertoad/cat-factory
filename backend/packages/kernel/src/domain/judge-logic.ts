import type { JudgeDisposition, JudgeFinding, JudgeVerdict } from './types.js'

// ---------------------------------------------------------------------------
// The PURE half of the judge machine (the `gate-logic.ts` counterpart): given a parsed
// verdict, the task's threshold, the registration's `onFail` disposition and the bounce
// budget, decide what the engine does. No ports, no I/O — so a judge's disposition is
// unit-testable without the engine, and a gate/judge package can reuse it.
//
// See `docs/initiatives/judge-registry.md`.
// ---------------------------------------------------------------------------

/** Rank of a {@link JudgeFinding} severity, for "at or above" comparisons. */
export const JUDGE_SEVERITY_RANK: Record<JudgeFinding['severity'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
}

/** What {@link disposeJudgeVerdict} needs to decide. */
export interface JudgeDispositionInput {
  /** The parsed verdict; its `score` is what the threshold compares. */
  verdict: JudgeVerdict
  /** The minimum score to advance, resolved from the task's merge preset. */
  threshold: number
  /** What the registration wants on a failing verdict. */
  onFail: 'park' | 'bounce' | 'fail'
  /** How many bounce rounds have already been spent. */
  bounces: number
  /** The bounce ceiling from the task's merge preset. */
  maxBounces: number
  /**
   * Whether a producing step actually precedes this judge. A `bounce` with nothing to bounce
   * to must NOT silently advance — it degrades to `park`, which is the whole reason this is a
   * parameter rather than an assumption.
   */
  hasBounceTarget: boolean
}

/**
 * WHY a verdict parked, as a closed vocabulary rather than prose.
 *
 * The three are not interchangeable, and only one of them is the automation reporting that it
 * GAVE UP:
 *  - `budget_spent` — the rework rounds are exhausted and the judge stopped trying. A person's
 *    answer here only confirms that, which is what makes it the one an unattended risk policy
 *    may answer on their behalf (ADR 0053).
 *  - `no_bounce_target` — the verdict is below the bar and there is no producing step to send it
 *    back to. The automation never got to try, so accepting the work anyway is a JUDGEMENT, and
 *    a policy that took it would be waving through work nothing reviewed.
 *  - `registration` — the judge declared `onFail: 'park'`, i.e. its author asked for a human.
 *    That is a park somebody REQUESTED, in the same class as a pipeline's approval gate, and
 *    autonomy never touches those.
 *
 * It exists so the engine branches on a value rather than matching {@link
 * JudgeDispositionResult.note}, which is display prose one wording change away from re-pointing
 * the decision silently.
 */
export type JudgeParkReason = 'budget_spent' | 'no_bounce_target' | 'registration'

/** The decision plus the reason to record on the step (surfaced in the window + PR report). */
export interface JudgeDispositionResult {
  disposition: JudgeDisposition
  /** Human-readable reason, recorded on `step.judge.note` for a non-obvious outcome. */
  note?: string
  /** Set exactly when `disposition` is `park`; see {@link JudgeParkReason}. */
  parkReason?: JudgeParkReason
}

/**
 * Decide what to do with a verdict.
 *
 *  - at or above the threshold → `pass` (the run advances);
 *  - below it, `onFail: 'fail'` → `fail`;
 *  - below it, `onFail: 'bounce'` with budget AND a target → `bounce`;
 *  - below it, `onFail: 'bounce'` with the budget spent, or no producing step to bounce to
 *    → `park` (never a silent advance — a judge that gave up must say so to a human);
 *  - below it, `onFail: 'park'` → `park`.
 *
 * The float comparison is `>=` on purpose: a threshold of `0.7` must be met exactly by a
 * verdict of `0.7`, which is the number an operator typed into the preset.
 */
export function disposeJudgeVerdict(input: JudgeDispositionInput): JudgeDispositionResult {
  const { verdict, threshold, onFail, bounces, maxBounces, hasBounceTarget } = input
  if (verdict.score >= threshold) return { disposition: 'pass' }
  if (onFail === 'fail') return { disposition: 'fail' }
  if (onFail === 'bounce') {
    if (!hasBounceTarget) {
      return {
        disposition: 'park',
        note: 'No preceding producing step to bounce to, so the verdict needs a human decision.',
        parkReason: 'no_bounce_target',
      }
    }
    if (bounces >= maxBounces) {
      return {
        disposition: 'park',
        note: `Rework budget spent (${bounces}/${maxBounces} bounce round(s)); asking a human.`,
        parkReason: 'budget_spent',
      }
    }
    return { disposition: 'bounce' }
  }
  return { disposition: 'park', parkReason: 'registration' }
}

/**
 * Render a verdict's findings as the rework brief handed to a bounced producing step. Kept
 * pure + here (rather than in the engine) so a registration can reuse the exact wording the
 * driver would have used. Severity-ordered, worst first, so a truncating producer reads the
 * things that matter.
 */
export function renderJudgeRework(
  verdict: JudgeVerdict,
  rubricName: string,
  extraFeedback?: string | null,
): string {
  const findings = [...(verdict.findings ?? [])].sort(
    (a, b) => JUDGE_SEVERITY_RANK[b.severity] - JUDGE_SEVERITY_RANK[a.severity],
  )
  const lines = [
    `The "${rubricName}" review scored this work ${verdict.score.toFixed(2)} and asked for changes.`,
  ]
  if (verdict.summary.trim()) lines.push('', verdict.summary.trim())
  if (findings.length) {
    lines.push('', 'Address each of the following:')
    for (const f of findings) {
      const where = f.where ? ` (${f.where})` : ''
      lines.push(`- [${f.severity}] ${f.title}${where}${f.detail ? ` — ${f.detail}` : ''}`)
    }
  }
  if (extraFeedback?.trim()) lines.push('', `Additional guidance: ${extraFeedback.trim()}`)
  return lines.join('\n')
}
