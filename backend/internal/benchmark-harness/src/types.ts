import type { ModelRef } from '@cat-factory/kernel'

// Shared shapes for the benchmark matrix. A "cell" is one point in the
// task × fixture × model × prompt-variant grid; running it yields a
// CandidateResult; the Claude arbiter skill later attaches a CellGrade.

export type TaskType = 'requirement-review' | 'code-review' | 'implementation'

export const TASK_TYPES: readonly TaskType[] = [
  'requirement-review',
  'code-review',
  'implementation',
]

/** An OpenAI-compatible endpoint Pi can be pointed at (implementation task). */
export interface PiEndpoint {
  baseUrl: string
  /** Env var holding the bearer key for this endpoint (read at run time). */
  keyEnv: string
}

/** A model under test. `endpoint` is only needed for the Pi-driven task. */
export interface ModelCandidate {
  /** Report label; defaults to `provider:model`. */
  label?: string
  ref: ModelRef
  endpoint?: PiEndpoint
}

/**
 * A prompt variant under test. The default variant for a `promptId` uses the
 * built-in, version-numbered cat-factory prompt; an experimental variant
 * overrides `system` and gets its own `version` number for change management.
 */
export interface PromptVariant {
  /** Which numbered prompt this varies: 'requirement-review' | 'build' | 'review'. */
  promptId: string
  /** Integer version (built-ins resolve from the core registry; variants set their own). */
  version?: number
  label?: string
  /** Override the system prompt; when omitted the built-in versioned prompt is used. */
  system?: string
  temperature?: number
  maxOutputTokens?: number
}

/** A single point in the benchmark grid. */
export interface CellKey {
  task: TaskType
  fixtureId: string
  /** Friendly model label. */
  modelLabel: string
  /** Exact `provider:model` id that produced the output. */
  model: string
  /** Exact prompt version, `id@vN`. */
  prompt: string
  /** Friendly variant label. */
  variant: string
}

/** The outcome of running one cell's candidate agent (pre-grading). */
export interface CandidateResult {
  id: string
  cell: CellKey
  /** The task input the agent reasoned over (rendered for the arbiter to read). */
  input: string
  output: string
  latencyMs: number
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
  costEur?: number
  error?: string
  /** Task-specific extras, e.g. the captured diff + Pi summary for implementation. */
  meta?: Record<string, unknown>
}

/** One rubric dimension the arbiter scores (1–5). */
export interface RubricDimension {
  key: string
  label: string
  description: string
  weight: number
}

export interface Rubric {
  task: TaskType
  dimensions: RubricDimension[]
}

/** A dimension score the arbiter skill assigns. */
export interface DimensionScore {
  key: string
  score: number
  rationale: string
}

/** The arbiter's grade for one cell. */
export interface CellGrade {
  id: string
  task: TaskType
  model: string
  prompt: string
  variant: string
  scores: DimensionScore[]
  /** Weighted mean of the dimension scores (1–5). */
  weightedTotal: number
  notes?: string
}

/** `grades.json` — what the arbiter skill writes for `cat-bench grade` to merge. */
export interface GradesFile {
  runId: string
  grades: CellGrade[]
}

/**
 * Filesystem-safe id for a cell — also the grading artifact's basename, so the
 * skill's grade can be matched back to its candidate deterministically.
 */
export function cellId(cell: CellKey): string {
  const parts = [cell.task, cell.fixtureId, cell.modelLabel, cell.variant]
  return parts.map((p) => p.replace(/[^a-zA-Z0-9._-]+/g, '-')).join('__')
}
