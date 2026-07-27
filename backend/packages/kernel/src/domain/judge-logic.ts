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

/** The decision plus the reason to record on the step (surfaced in the window + PR report). */
export interface JudgeDispositionResult {
  disposition: JudgeDisposition
  /** Human-readable reason, recorded on `step.judge.note` for a non-obvious outcome. */
  note?: string
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
      }
    }
    if (maxBounces <= 0) {
      // A budget of 0 is "never bounce" (the `mp_manual_review` preset ships exactly this), NOT
      // a budget that ran out. Reporting it as "spent 0/0" describes a rework round that was
      // never on offer, which reads to an operator like a bug in the judge rather than the
      // policy they chose.
      return {
        disposition: 'park',
        note: "This task's preset allows no rework rounds, so the verdict goes straight to a human.",
      }
    }
    if (bounces >= maxBounces) {
      return {
        disposition: 'park',
        note: `Rework budget spent (${bounces}/${maxBounces} bounce round(s)); asking a human.`,
      }
    }
    return { disposition: 'bounce' }
  }
  return { disposition: 'park' }
}

/**
 * Explain a verdict whose score was silently zeroed because the model answered on the wrong
 * scale. Both the canonical `judgeVerdictSchema` and a registration's own schema wrap `score` in
 * a `v.fallback(… minValue(0), maxValue(1) …, 0)`, so a model that replied `85` (a 0..100 scale)
 * yields a verdict scoring **0.00** beside a perfectly sensible summary — which reads to a
 * reviewer as "the work is worthless" rather than "the judge could not read the number".
 *
 * The zero itself is correct and deliberate (an unreadable verdict must land on the cautious
 * side of the threshold), so this does NOT rescale or rescue it — rescaling would be guessing at
 * the model's intent on the permissive side. It only makes the cause visible: a `critical`
 * finding stating what came back, which the window, the PR report and a bounced producer's
 * rework brief all already render.
 *
 * Returns the verdict unchanged when the raw score was absent or in range.
 */
export function annotateOutOfRangeScore(raw: unknown, verdict: JudgeVerdict): JudgeVerdict {
  if (verdict.score !== 0) return verdict
  const rawScore = (raw as { score?: unknown } | null | undefined)?.score
  if (typeof rawScore !== 'number' || !Number.isFinite(rawScore)) return verdict
  if (rawScore >= 0 && rawScore <= 1) return verdict
  return {
    ...verdict,
    findings: [
      {
        title: 'The rubric assessment scored on the wrong scale',
        detail:
          `The review replied with a score of ${rawScore}, which is outside the required 0..1 ` +
          `range, so it was recorded as 0 rather than guessed at. The findings below (if any) ` +
          `are still the review's own.`,
        severity: 'critical',
      },
      ...(verdict.findings ?? []),
    ],
  }
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
