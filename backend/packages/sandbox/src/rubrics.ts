// Grading rubrics for the Sandbox judge. Reference-free: each dimension is scored 1–5 by the
// judge model against the task input + the candidate output; the weighted mean is the cell score.
//
// The first three (`requirement-review`, `code-review`, `implementation`) are lifted verbatim from
// the benchmark harness's rubrics (`backend/internal/benchmark-harness/src/rubrics.ts`) so the
// in-product Sandbox and the offline `cat-bench` grade on the same axes. Those copies are pinned
// equal by `benchmark-harness/test/rubrics.conformity.test.ts`, which also asserts every harness
// task IS a Sandbox task: a dimension added to one side and not the other does not fail anything on
// its own, it just quietly makes a Sandbox score and a benchmark score incomparable. Change one,
// change both.
//
// The remaining rubrics are Sandbox-only, because the offline harness has no runner for them. They
// exist because a rubric is a claim about what the task IS: grading an architecture critique or a
// bug triage on `requirement-review` scored them against `product_scope`, a dimension that
// penalizes exactly the technical findings those two stages are FOR.

/**
 * The grading task a Sandbox agent kind maps to (drives which rubric is used).
 *
 * Adding a member means adding its dimension list to {@link RUBRICS}, which is a
 * `Record<SandboxTaskType, …>` and so fails to compile until it is there.
 */
export type SandboxTaskType =
  | 'requirement-review'
  | 'code-review'
  | 'implementation'
  | 'architecture-review'
  | 'bug-triage'
  | 'estimation'
  | 'answer-recommendation'

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
      'Surfaces the genuine product-level gaps, ambiguities and risks that would block confident implementation.',
    weight: 3,
  },
  // The requirements-review stage settles the product / business layer only; the technical layer
  // is the architect's and researcher's, which see the repository and the `tech-spec/` and this
  // stage does not. No other dimension catches a well-written, well-calibrated finding that is
  // simply not this stage's to raise — `signal_noise` scores volume, not layer.
  {
    key: 'product_scope',
    label: 'Product scope discipline',
    description:
      'Raises only product / business questions a product owner who does not read code could ' +
      'answer. Leaves technology and library choice, architecture, API and schema shape, ' +
      'algorithms, performance technique and infrastructure to the architect and researcher, ' +
      'and does not smuggle one in at a low severity.',
    weight: 2,
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

// A design critique is the OPPOSITE of a requirements review on the one axis that matters: the
// technical layer is what it is FOR. Grading it on `requirement-review` docked it for every
// partition-key, durability and hot-key finding, which is why the architecture fixtures'
// highest-value expectations were the ones the rubric punished.
const ARCHITECTURE_REVIEW: RubricDimension[] = [
  {
    key: 'design_risk_detection',
    label: 'Design-risk detection',
    description:
      'Finds the genuine correctness, scaling, consistency and durability flaws in the proposed ' +
      'design, including the ones its own wording papers over.',
    weight: 3,
  },
  {
    key: 'failure_mode_reasoning',
    label: 'Failure-mode reasoning',
    description:
      'Reasons about what the design does when a component dies, two writes race, delivery ' +
      'retries or load is uneven, rather than only assessing the happy path.',
    weight: 3,
  },
  {
    key: 'tradeoff_grounding',
    label: 'Trade-off grounding',
    description:
      'Weighs the proposal against concrete alternatives and says what each one buys and costs, ' +
      'instead of asserting a preference.',
    weight: 2,
  },
  {
    key: 'operability',
    label: 'Operability',
    description:
      'Covers what running this actually needs: rollout and migration, what is observable, the ' +
      'cost shape, and what a person would be paged for.',
    weight: 1,
  },
  {
    key: 'actionability',
    label: 'Actionability',
    description:
      'Each finding names the part of the design it concerns and what to change; no generic ' +
      'architecture advice that would apply to any proposal.',
    weight: 2,
  },
  {
    key: 'false_positives',
    label: 'Few false positives',
    description:
      'Does not invent flaws or demand scale the stated context does not need, and says plainly ' +
      'where a choice is sound.',
    weight: 2,
  },
]

// Bug triage shares nothing with a requirements review except its output shape. Its whole job is
// to make an unactionable report diagnosable, and the two moves that decide whether it succeeded
// (splitting conflated symptoms, and asking about containment rather than only the fix) had no
// dimension of their own.
const BUG_TRIAGE: RubricDimension[] = [
  {
    key: 'missing_facts',
    label: 'Missing facts',
    description:
      'Asks for the facts that actually block a diagnosis: reproduction, scope, timing and the ' +
      'regression window, environment, and observed versus expected behaviour.',
    weight: 3,
  },
  {
    key: 'symptom_separation',
    label: 'Symptom separation',
    description:
      'Splits a report that conflates several distinct failures into separate issues rather ' +
      'than triaging them as one, and names what distinguishes them.',
    weight: 3,
  },
  {
    key: 'hypothesis_quality',
    label: 'Hypothesis quality',
    description:
      'Offers a concrete, testable cause where the evidence supports one (and says what would ' +
      'confirm it), without guessing where it does not.',
    weight: 2,
  },
  {
    key: 'containment',
    label: 'Blast radius & recovery',
    description:
      'Covers who is affected and how many, and whether anything lost or corrupted can be ' +
      'recovered, rather than treating the eventual fix as the whole response.',
    weight: 2,
  },
  {
    key: 'no_redundancy',
    label: 'No redundant questions',
    description:
      'Does not re-ask what the report or an attached investigation already answers; builds on ' +
      'the evidence it was given.',
    weight: 1,
  },
  {
    key: 'actionability',
    label: 'Actionability',
    description:
      'Each item is phrased so the reporter or an on-call engineer can act on it directly.',
    weight: 2,
  },
]

// A predictive triage returns three numbers and a paragraph, so every rubric written for prose
// grades it on axes it structurally cannot show. What matters instead is whether the numbers are
// defensible, independent of each other, and justified by something in the task.
const ESTIMATION: RubricDimension[] = [
  {
    key: 'calibration',
    label: 'Calibration',
    description:
      'The scores are defensible for the work described: neither anchored to the middle of the ' +
      'range nor uniformly extreme.',
    weight: 3,
  },
  {
    key: 'axis_independence',
    label: 'Axis independence',
    description:
      'Complexity, risk and impact are judged separately. A task may be intricate and safe, or ' +
      'trivial and dangerous; three near-identical numbers need a reason.',
    weight: 2,
  },
  {
    key: 'evidence',
    label: 'Evidence in the rationale',
    description:
      'The rationale names the specific things in the task that drive each score, rather than ' +
      'restating the task or asserting a level.',
    weight: 3,
  },
  {
    key: 'blast_radius_reasoning',
    label: 'Blast-radius reasoning',
    description:
      'Impact reflects who and how much is affected if the change goes wrong, not how large or ' +
      'how difficult the change is (that is complexity).',
    weight: 2,
  },
  {
    key: 'format_compliance',
    label: 'Format compliance',
    description:
      'Returns exactly the requested JSON object (the three numeric axes plus the rationale) ' +
      'and nothing else: no prose, no code fences, no extra keys.',
    weight: 1,
  },
]

// The Requirement Writer's two self-reported fields are what an unattended run acts on (ADR 0053):
// a confident answer may be adopted with nobody reading it, and `groundedIn` is the provenance a
// human checks before trusting one. Both are claims the writer makes about itself, so both get a
// dimension of their own; no prose rubric scores an honest provenance report.
const ANSWER_RECOMMENDATION: RubricDimension[] = [
  {
    key: 'answer_concreteness',
    label: 'Concrete, adoptable answers',
    description:
      'Each recommendation is a specific default a product owner could accept as written, not a ' +
      'restatement of the finding and not an "it depends".',
    weight: 3,
  },
  {
    key: 'product_scope',
    label: 'Product scope discipline',
    description:
      'Recommends product / business decisions only (a behaviour, rule, limit or boundary), ' +
      'never a technical design, and does not answer a technical question that slipped past the ' +
      'reviewer as if it were one.',
    weight: 2,
  },
  {
    key: 'grounding_honesty',
    label: 'Honest grounding',
    description:
      'Reports where each answer actually came from. A standard or the project spec is cited ' +
      'only when it genuinely settles the finding; general knowledge is labelled as such rather ' +
      'than dressed up as sourced.',
    weight: 3,
  },
  {
    key: 'confidence_calibration',
    label: 'Confidence calibration',
    description:
      'Confidence reflects how sure the answer is the one THIS project would choose. High ' +
      'confidence is reserved for answers that need nobody to sign off; anything turning on ' +
      'unstated business specifics is rated low.',
    weight: 3,
  },
  {
    key: 'coverage',
    label: 'Coverage',
    description:
      'Answers every finding it was given, one entry per id, with none dropped, merged or ' +
      'invented.',
    weight: 2,
  },
  {
    key: 'concision',
    label: 'Concision',
    description: 'States the answer in a few sentences, without preamble, hedging or padding.',
    weight: 1,
  },
]

const RUBRICS: Record<SandboxTaskType, RubricDimension[]> = {
  'requirement-review': REQUIREMENT_REVIEW,
  'code-review': CODE_REVIEW,
  implementation: IMPLEMENTATION,
  'architecture-review': ARCHITECTURE_REVIEW,
  'bug-triage': BUG_TRIAGE,
  estimation: ESTIMATION,
  'answer-recommendation': ANSWER_RECOMMENDATION,
}

/**
 * Every grading task the Sandbox ships, as a value.
 *
 * Exported so a consumer can enumerate the rubrics rather than re-listing them: the
 * benchmark-harness conformity guard reads it to assert that every task the OFFLINE harness grades
 * is also a Sandbox task with identical dimensions, which is a relation over a list it does not
 * own. Derived from {@link RUBRICS} so adding a rubric extends it with no second edit.
 */
export const SANDBOX_TASK_TYPES = Object.keys(RUBRICS) as readonly SandboxTaskType[]

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
