import type { SandboxExpectation } from '@cat-factory/contracts'

// Grading rubrics for the Sandbox judge. These are lifted verbatim (and kept in
// sync) with the benchmark harness's rubrics (`backend/internal/benchmark-harness/
// src/rubrics.ts`) so the in-product Sandbox and the offline `cat-bench` grade on
// the same axes. Reference-free: each dimension is scored 1–5 by the judge model
// against the task input + the candidate output; the weighted mean is the cell score.

/** The grading task a Sandbox agent kind maps to (drives which rubric is used). */
export type SandboxTaskType = 'requirement-review' | 'code-review' | 'implementation'

export interface RubricDimension {
  key: string
  label: string
  description: string
  weight: number
}

export interface Rubric {
  task: SandboxTaskType
  dimensions: RubricDimension[]
}

const REQUIREMENT_REVIEW: RubricDimension[] = [
  {
    key: 'gap_coverage',
    label: 'Gap coverage',
    description:
      'Surfaces the genuine gaps, ambiguities and risks that would block confident implementation.',
    weight: 3,
  },
  {
    key: 'specificity',
    label: 'Specificity & actionability',
    description: 'Each item is concrete and phrased so a product owner can answer it directly.',
    weight: 2,
  },
  {
    key: 'no_hallucination',
    label: 'No invented requirements',
    description:
      'Does not fabricate requirements or answers; raises questions instead of guessing.',
    weight: 3,
  },
  {
    key: 'severity_calibration',
    label: 'Severity calibration',
    description: 'Severity/category labels are sensible and ordered high-impact first.',
    weight: 1,
  },
  {
    key: 'signal_noise',
    label: 'Signal vs noise',
    description: 'Avoids trivial or duplicate items; volume matches the actual ambiguity.',
    weight: 1,
  },
]

const CODE_REVIEW: RubricDimension[] = [
  {
    key: 'issue_detection',
    label: 'Real-issue detection',
    description: 'Finds the genuine correctness, security and edge-case problems in the work.',
    weight: 3,
  },
  {
    key: 'correctness',
    label: 'Correctness of findings',
    description: 'Findings are technically accurate and the proposed fixes are sound.',
    weight: 3,
  },
  {
    key: 'severity_order',
    label: 'Severity ordering',
    description: 'Orders findings blocker → nit and separates must-fix from optional.',
    weight: 1,
  },
  {
    key: 'actionability',
    label: 'Actionability',
    description: 'References the specific code each finding concerns; fixes are concrete.',
    weight: 2,
  },
  {
    key: 'false_positives',
    label: 'Few false positives',
    description: 'Does not invent problems; acknowledges sound code rather than nit-picking.',
    weight: 2,
  },
]

const IMPLEMENTATION: RubricDimension[] = [
  {
    key: 'faithfulness',
    label: 'Design faithfulness',
    description: 'Implements the agreed design and resolved decisions without silent redesign.',
    weight: 3,
  },
  {
    key: 'correctness',
    label: 'Correctness',
    description: 'The diff is correct, handles errors/edge cases, and would plausibly pass CI.',
    weight: 3,
  },
  {
    key: 'completeness',
    label: 'Completeness',
    description: 'Covers the requested scope; no obvious missing pieces or stubs left behind.',
    weight: 2,
  },
  {
    key: 'scope_discipline',
    label: 'Scope discipline',
    description: 'Stays within scope; no speculative abstraction or unrelated churn.',
    weight: 1,
  },
  {
    key: 'code_quality',
    label: 'Code quality',
    description: 'Cohesive, readable, idiomatic to the surrounding codebase.',
    weight: 1,
  },
]

const RUBRICS: Record<SandboxTaskType, RubricDimension[]> = {
  'requirement-review': REQUIREMENT_REVIEW,
  'code-review': CODE_REVIEW,
  implementation: IMPLEMENTATION,
}

export function rubricFor(task: SandboxTaskType): Rubric {
  return { task, dimensions: RUBRICS[task] }
}

/** Weighted mean of dimension scores (1–5), using the rubric weights. */
export function weightedTotal(
  task: SandboxTaskType,
  scores: { key: string; score: number }[],
): number {
  const dims = RUBRICS[task]
  let sum = 0
  let weight = 0
  for (const dim of dims) {
    const score = scores.find((s) => s.key === dim.key)?.score
    if (typeof score === 'number') {
      sum += score * dim.weight
      weight += dim.weight
    }
  }
  return weight === 0 ? 0 : Math.round((sum / weight) * 100) / 100
}

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
   * a high-impact item moves this far more than missing a low-impact one — the asymmetry the
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
 * candidate output as a contiguous run of word tokens — case/whitespace/punctuation
 * insensitive, so `reset logic` does not match inside `preset logic`. Recorded ALONGSIDE
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
    const hit = hints.some((hint) => {
      const needle = tokenize(hint)
      return needle.length > 0 && containsSequence(haystack, needle)
    })
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
 * Render the graded expectations into a Markdown section to append to the judge prompt —
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

/** Lowercase alphanumeric word tokens (drops punctuation/whitespace). */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

/** Whether `needle`'s tokens appear as a contiguous run within `haystack`'s tokens. */
function containsSequence(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let hit = true
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}
