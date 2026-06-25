import type {
  SandboxExpectation,
  SandboxFixture,
  SandboxGradeDimension,
  SandboxObjectiveResult,
} from '@cat-factory/contracts'
import type { ModelRef } from '@cat-factory/kernel'
import {
  type ExpectationScore,
  type Rubric,
  renderExpectationBrief,
  scoreExpectations,
} from '@cat-factory/sandbox'

// Pure helpers for the Sandbox run-driver + judge. Kept side-effect-free (no LLM/IO,
// no clock/identity) so the candidate-input rendering, judge-prompt assembly, score
// coercion and objective projection are deterministic and unit-testable; the service
// wraps them with the model-provider calls + persistence.

/** Split a model catalog id (`provider:model`) into a {@link ModelRef}. */
export function parseModelCatalogId(id: string): ModelRef {
  const idx = id.indexOf(':')
  if (idx === -1) return { provider: id, model: '' }
  return { provider: id.slice(0, idx), model: id.slice(idx + 1) }
}

/**
 * Render an inline fixture's payload into the task input the candidate reasons over (its
 * system prompt carries the role instructions) and the judge grades against. Defensive:
 * the payload is a `Record<string, unknown>` matching a `RequirementsContext` /
 * `ClarityContext` (a `block` + optional `docs`/`tasks`) or a reviewer `AgentRunContext`
 * (a `block` + the work-to-review in `priorOutputs`), so it reads each field tolerantly.
 */
export function renderFixtureInput(fixture: SandboxFixture): string {
  const payload = (fixture.payload ?? {}) as Record<string, unknown>
  const parts: string[] = []

  const block = payload.block as
    | { title?: string; type?: string; description?: string }
    | undefined
  if (block) {
    const heading = block.type ? `${block.title ?? 'Untitled'} (${block.type})` : block.title
    parts.push(`# ${heading ?? 'Untitled'}`)
    if (block.description) parts.push(block.description)
  }

  const docs = Array.isArray(payload.docs) ? (payload.docs as unknown[]) : []
  if (docs.length > 0) {
    parts.push('## Linked documents')
    for (const doc of docs) {
      const d = doc as { title?: string; body?: string; content?: string }
      parts.push(`### ${d.title ?? 'Document'}\n${d.body ?? d.content ?? ''}`.trim())
    }
  }

  const tasks = Array.isArray(payload.tasks) ? (payload.tasks as unknown[]) : []
  if (tasks.length > 0) {
    parts.push('## Linked tracker issues')
    for (const task of tasks) {
      const t = task as { title?: string; body?: string }
      parts.push(`- ${t.title ?? 'Issue'}${t.body ? `: ${t.body}` : ''}`)
    }
  }

  const priorOutputs = Array.isArray(payload.priorOutputs)
    ? (payload.priorOutputs as unknown[])
    : []
  if (priorOutputs.length > 0) {
    parts.push('## Work from earlier agents')
    for (const prior of priorOutputs) {
      const p = prior as { agentKind?: string; output?: string }
      parts.push(`### ${p.agentKind ?? 'agent'}\n${p.output ?? ''}`.trim())
    }
  }

  return parts.join('\n\n').trim()
}

/** System prompt for the Sandbox judge — a reference-free rubric grader. */
export const JUDGE_SYSTEM_PROMPT = [
  'You are a meticulous, impartial evaluator. You grade an AI agent\'s output for a given',
  'task against a fixed rubric, scoring each dimension from 1 (poor) to 5 (excellent).',
  'Judge ONLY against the task input and the candidate output you are given — never invent',
  'context. Be calibrated: reserve 5 for genuinely excellent work and 1 for output that',
  'fails the dimension outright. Your entire visible reply MUST be the requested JSON object',
  'and nothing else (do not put the answer in a reasoning/thinking channel).',
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
  const byKey = new Map<string, { score?: unknown; rationale?: unknown }>()
  const scores = extractScoreArray(raw)
  for (const entry of scores) {
    if (entry && typeof entry === 'object' && typeof (entry as { key?: unknown }).key === 'string') {
      byKey.set((entry as { key: string }).key, entry as { score?: unknown; rationale?: unknown })
    }
  }
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
export function toFindingsObjectiveResult(score: ExpectationScore): SandboxObjectiveResult {
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
export function objectiveFor(fixture: SandboxFixture, output: string): SandboxObjectiveResult | null {
  const objective = fixture.objective
  if (!objective || objective.kind !== 'findings') return null
  return toFindingsObjectiveResult(scoreExpectations(objective.expectations, output))
}

/** Extract the first JSON value (object or array) embedded in a model's reply. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1]! : trimmed
  const start = candidate.search(/[[{]/)
  if (start === -1) return null
  const open = candidate[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i]
    if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
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
