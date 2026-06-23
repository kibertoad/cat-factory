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

/**
 * Heuristic objective score for `findings` fixtures: how many of the planted
 * expected findings appear in the candidate output. Each expected finding is matched
 * case-insensitively as a normalized substring (whitespace collapsed). This is a
 * cheap, deterministic recall signal recorded ALONGSIDE the judge grade — it is not a
 * substitute for the judge and intentionally does not penalize extra findings (that's
 * the judge's `false_positives` dimension). Returns matched count, total, and recall.
 */
export function scoreExpectedFindings(
  expectedFindings: string[],
  output: string,
): { matched: number; total: number; recall: number; missing: string[] } {
  const haystack = normalize(output)
  const missing: string[] = []
  let matched = 0
  for (const finding of expectedFindings) {
    const needle = normalize(finding)
    if (needle.length > 0 && haystack.includes(needle)) matched++
    else missing.push(finding)
  }
  const total = expectedFindings.length
  const recall = total === 0 ? 1 : Math.round((matched / total) * 100) / 100
  return { matched, total, recall, missing }
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}
