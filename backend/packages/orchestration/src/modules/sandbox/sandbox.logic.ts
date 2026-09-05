import type {
  SandboxExpectation,
  SandboxFixture,
  SandboxGradeDimension,
  SandboxObjectiveResult,
} from '@cat-factory/contracts'
import type { ModelRef } from '@cat-factory/kernel'
import { FINAL_ANSWER_IN_REPLY } from '@cat-factory/agents'
import {
  type ExpectationScore,
  type Rubric,
  renderExpectationBrief,
  scoreExpectations,
} from '@cat-factory/sandbox'

// The robust LLM-reply JSON extractor lives in the kernel (one copy shared by the
// requirements reviewer, the document planner, and the Sandbox judge). Re-exported here
// so the run-driver imports it alongside the other judge helpers.
export { extractJson } from '@cat-factory/kernel'

// Pure helpers for the Sandbox run-driver + judge. Kept side-effect-free (no LLM/IO,
// no clock/identity) so the judge-prompt assembly, score coercion and objective projection are
// deterministic and unit-testable; the service wraps them with the model-provider calls +
// persistence. The candidate's TASK INPUT is built in `sandbox-input.ts`, which routes each kind
// through the pure prompt builder its production caller uses.

/** Split a model catalog id (`provider:model`) into a {@link ModelRef}. */
export function parseModelCatalogId(id: string): ModelRef {
  const idx = id.indexOf(':')
  if (idx === -1) return { provider: id, model: '' }
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) }
}

/** System prompt for the Sandbox judge — a reference-free rubric grader. */
export const JUDGE_SYSTEM_PROMPT = [
  "You are a meticulous, impartial evaluator. You grade an AI agent's output for a given",
  'task against a fixed rubric, scoring each dimension from 1 (poor) to 5 (excellent).',
  'Judge ONLY against the task input and the candidate output you are given — never invent',
  'context. Be calibrated: reserve 5 for genuinely excellent work and 1 for output that',
  'fails the dimension outright. Your entire visible reply MUST be the requested JSON object',
  'and nothing else.',
  // The judge's deliverable IS its (parsed) final reply, so append the shared directive
  // that keeps reasoning models from emitting the answer into a hidden thinking channel.
  FINAL_ANSWER_IN_REPLY,
].join(' ')

/** Build the judge user prompt for one cell: rubric + task input + candidate output + expectations. */
export function buildJudgePrompt(
  rubric: Rubric,
  taskInput: string,
  output: string,
  expectations: readonly SandboxExpectation[],
): string {
  const dims = rubric.dimensions
    .map((d) => `- "${d.key}" — ${d.label}: ${d.description}`)
    .join('\n')
  const brief = renderExpectationBrief(expectations)
  return [
    `You are grading an AI agent's output for a "${rubric.task}" task.`,
    '',
    '## Task input',
    taskInput || '(no task input was supplied)',
    '',
    '## Candidate output',
    output.trim() || '(the candidate produced no output)',
    '',
    '## Rubric — score every dimension from 1 to 5',
    dims,
    ...(brief ? ['', brief] : []),
    '',
    'Respond with ONLY this JSON object (no prose, no code fences):',
    '{"scores":[{"key":"<dimension key>","score":<1-5>,"rationale":"<one short sentence>"}]}',
    'Include every dimension key exactly once.',
  ].join('\n')
}

/**
 * Coerce a judge's raw JSON into one score per rubric dimension. Scores are clamped to
 * [1,5]; a dimension the judge omitted (or scored non-numerically) defaults to 1 with a
 * note, so the weighted mean never silently drops a dimension from its denominator.
 */
export function coerceJudgeScores(rubric: Rubric, raw: unknown): SandboxGradeDimension[] {
  const byKey = scoreEntriesByKey(raw)
  return rubric.dimensions.map((dim) => {
    const found = byKey.get(dim.key)
    const score = clampScore(found?.score)
    const rationale =
      typeof found?.rationale === 'string' && found.rationale.trim()
        ? found.rationale.trim()
        : score === null
          ? 'Judge did not score this dimension.'
          : ''
    return { key: dim.key, score: score ?? 1, rationale }
  })
}

/** Project the deterministic objective score into the wire `SandboxObjectiveResult` (findings). */
function toFindingsObjectiveResult(score: ExpectationScore): SandboxObjectiveResult {
  return {
    kind: 'findings',
    pass: score.missedHighImpact.length === 0,
    detail: `Caught ${score.caught.length}/${score.caught.length + score.missed.length} expected findings; impact recall ${score.impactRecall}, wow bonus ${score.wowBonus}.`,
    impactRecall: score.impactRecall,
    wowBonus: score.wowBonus,
    caught: score.caught.length,
    total: score.caught.length + score.missed.length,
    missedHighImpact: score.missedHighImpact,
  }
}

/** Score a candidate's output against a fixture's `findings` objective, if it declares one. */
export function objectiveFor(
  fixture: SandboxFixture,
  output: string,
): SandboxObjectiveResult | null {
  const objective = fixture.objective
  if (!objective || objective.kind !== 'findings') return null
  return toFindingsObjectiveResult(scoreExpectations(objective.expectations, output))
}

/**
 * How many rubric dimensions the judge actually scored with a usable numeric value. The
 * run-driver treats a count of 0 as a grading FAILURE (record an error on the cell) rather
 * than letting {@link coerceJudgeScores} silently floor every dimension to 1 — an
 * unparseable / empty / reasoning-only judge reply must not masquerade as a confident
 * bottom-of-scale grade.
 */
export function gradedDimensionCount(rubric: Rubric, raw: unknown): number {
  const byKey = scoreEntriesByKey(raw)
  let count = 0
  for (const dim of rubric.dimensions) {
    if (clampScore(byKey.get(dim.key)?.score) !== null) count++
  }
  return count
}

function scoreEntriesByKey(raw: unknown): Map<string, { score?: unknown; rationale?: unknown }> {
  const byKey = new Map<string, { score?: unknown; rationale?: unknown }>()
  for (const entry of extractScoreArray(raw)) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as { key?: unknown }).key === 'string'
    ) {
      byKey.set((entry as { key: string }).key, entry as { score?: unknown; rationale?: unknown })
    }
  }
  return byKey
}

function extractScoreArray(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (raw && typeof raw === 'object' && Array.isArray((raw as { scores?: unknown }).scores)) {
    return (raw as { scores: unknown[] }).scores
  }
  return []
}

function clampScore(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n)) return null
  return Math.min(5, Math.max(1, n))
}
