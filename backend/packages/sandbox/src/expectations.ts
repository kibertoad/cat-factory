import type { SandboxExpectation } from '@cat-factory/contracts'

// The deterministic, asymmetric OBJECTIVE scorer for `findings` fixtures, and the judge brief it
// shares its grading model with. Split from `rubrics.ts` because the two answer different
// questions: a rubric is what the JUDGE model scores, this is what the platform COMPUTES from the
// candidate text with no model in the loop. The two signals are recorded side by side and never
// blended (see `SandboxGrade.objective`).

/** An expectation is "high-impact" (a serious miss) at or above this impact rating. */
export const HIGH_IMPACT_THRESHOLD = 4
/** An expectation is "tricky" (its catch earns the wow bonus) at or above this rating. */
export const TRICKY_THRESHOLD = 4

export interface ExpectationScore {
  /** Expectations the candidate output surfaced. */
  caught: SandboxExpectation[]
  /** Expectations the candidate output missed. */
  missed: SandboxExpectation[]
  /**
   * Impact-weighted recall in [0,1]: `1 − Σ(impact of missed) / Σ(impact of all)`. Missing
   * a high-impact item moves this far more than missing a low-impact one, which is the asymmetry the
   * fixtures are graded on. 1 when there are no expectations.
   */
  impactRecall: number
  /**
   * Trickiness-weighted "wow" bonus in [0,1]: `Σ(trickiness of caught tricky items) /
   * Σ(trickiness of all tricky items)`. Only the genuinely tricky items (trickiness ≥
   * {@link TRICKY_THRESHOLD}) contribute, so catching a hard-to-spot finding is rewarded
   * while missing one is not penalized here (impact handles penalties). 1 when nothing is
   * tricky (no wow on offer).
   */
  wowBonus: number
  /** Ids of missed expectations with impact ≥ {@link HIGH_IMPACT_THRESHOLD}. */
  missedHighImpact: string[]
}

/**
 * Deterministic, asymmetric objective score for `findings` fixtures. An expectation is
 * "caught" when any of its `matchHints` (defaulting to its `summary`) appears in the
 * candidate output as a contiguous run of word tokens (case, whitespace and punctuation
 * insensitive), so `reset logic` does not match inside `preset logic`. Recorded ALONGSIDE
 * the judge grade (never blended in); it intentionally does not penalize extra findings
 * (that is the judge's `false_positives` dimension). The two signals are deliberately
 * different: `impactRecall` punishes missing what matters, `wowBonus` rewards catching what
 * is hard to spot. See {@link SandboxExpectation}.
 */
export function scoreExpectations(
  expectations: readonly SandboxExpectation[],
  output: string,
): ExpectationScore {
  const haystack = tokenize(output)
  const caught: SandboxExpectation[] = []
  const missed: SandboxExpectation[] = []
  for (const expectation of expectations) {
    const hints = expectation.matchHints.length > 0 ? expectation.matchHints : [expectation.summary]
    const hit = hints.some((hint) => matchesHint(haystack, hint))
    ;(hit ? caught : missed).push(expectation)
  }

  const totalImpact = expectations.reduce((sum, e) => sum + e.impact, 0)
  const missedImpact = missed.reduce((sum, e) => sum + e.impact, 0)
  const impactRecall = totalImpact === 0 ? 1 : round2(1 - missedImpact / totalImpact)

  const trickyTotal = expectations
    .filter((e) => e.trickiness >= TRICKY_THRESHOLD)
    .reduce((sum, e) => sum + e.trickiness, 0)
  const trickyCaught = caught
    .filter((e) => e.trickiness >= TRICKY_THRESHOLD)
    .reduce((sum, e) => sum + e.trickiness, 0)
  const wowBonus = trickyTotal === 0 ? 1 : round2(trickyCaught / trickyTotal)

  const missedHighImpact = missed.filter((e) => e.impact >= HIGH_IMPACT_THRESHOLD).map((e) => e.id)
  return { caught, missed, impactRecall, wowBonus, missedHighImpact }
}

/**
 * Render the graded expectations into a Markdown section to append to the judge prompt:
 * "what the judge should expect to see", with the scoring guidance the asymmetry implies.
 * Returns an empty string when there are no expectations (an un-graded fixture).
 */
export function renderExpectationBrief(expectations: readonly SandboxExpectation[]): string {
  if (expectations.length === 0) return ''
  const lines = [
    '## Expected findings (grading reference)',
    '',
    'A strong response should surface the following. Each is rated by **impact** (how bad it',
    'is to miss, 1–5) and **trickiness** (how hard it is to spot, 1–5). Reward catching',
    'high-trickiness items — those are the impressive catches. Penalize missing high-impact',
    'items most heavily; missing a merely tricky item is a smaller concern.',
    '',
  ]
  for (const e of expectations) {
    lines.push(`- **${e.summary}** _(impact ${e.impact}, trickiness ${e.trickiness})_`)
    if (e.detail.trim()) lines.push(`  - ${e.detail.trim()}`)
  }
  return lines.join('\n')
}

/** Round to 2 decimal places. */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Whether one hint matches the tokenized output.
 *
 * A trailing `*` makes the hint's LAST token match by prefix, so `idempoten*` catches
 * "idempotent", "idempotency" and "idempotently" from one hint. Without it, matching is token
 * EQUALITY throughout, which is why a bare stem is a dead hint: `idempoten` is not the token
 * `idempotent`, so it scores "missed" for every answer forever while looking entirely reasonable
 * in the fixture. The wildcard is explicit rather than inferred from a token's length, because a
 * heuristic would also silently loosen the deliberate whole-word hints (`Map`, `atomic`) that
 * carry the opposite intent.
 */
function matchesHint(haystack: string[], hint: string): boolean {
  const needle = tokenize(hint)
  if (needle.length === 0) return false
  return containsSequence(haystack, needle, hint.trimEnd().endsWith('*'))
}

/** Lowercase alphanumeric word tokens (drops punctuation/whitespace). */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/**
 * Whether `needle`'s tokens appear as a contiguous run within `haystack`'s tokens. With
 * `prefixTail`, the final needle token need only be a PREFIX of the token it lands on.
 */
function containsSequence(haystack: string[], needle: string[], prefixTail = false): boolean {
  if (needle.length === 0) return false
  const last = needle.length - 1
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      const token = haystack[i + j] ?? ''
      const matched =
        prefixTail && j === last ? token.startsWith(needle[j] ?? '') : token === needle[j]
      if (!matched) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}
