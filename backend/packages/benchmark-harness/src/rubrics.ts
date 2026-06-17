import type { Rubric, RubricDimension, TaskType } from './types'

// Per-task grading rubrics. Reference-free: each dimension is scored 1–5 by the
// Claude arbiter skill against the task input + the candidate output. The same
// definitions drive both the skill's instructions (embedded into each grading
// artifact) and the report's weighting, so they cannot drift.

const REQUIREMENT_REVIEW: RubricDimension[] = [
  {
    key: 'gap_coverage',
    label: 'Gap coverage',
    description: 'Surfaces the genuine gaps, ambiguities and risks that would block confident implementation.',
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
    description: 'Does not fabricate requirements or answers; raises questions instead of guessing.',
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

const RUBRICS: Record<TaskType, RubricDimension[]> = {
  'requirement-review': REQUIREMENT_REVIEW,
  'code-review': CODE_REVIEW,
  implementation: IMPLEMENTATION,
}

export function rubricFor(task: TaskType): Rubric {
  return { task, dimensions: RUBRICS[task] }
}

/** Weighted mean of dimension scores (1–5), using the rubric weights. */
export function weightedTotal(
  task: TaskType,
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
