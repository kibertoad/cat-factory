import type { TaskEstimate } from '@cat-factory/kernel'
import { extractJson } from '../requirements/requirements.logic.js'

// Pure helpers for the core `task-estimator` step: tolerant parsing of the
// agent's JSON triage into a {@link TaskEstimate}, plus a readable summary the
// board shows in place of the raw JSON. Kept pure (no I/O) for unit testing. The
// tolerant JSON extraction is the shared `extractJson` helper (same package).

/** Clamp a finite number into [0,1]; null for anything non-numeric. */
function clamp01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

/**
 * Coerce a task-estimator agent's output into a {@link TaskEstimate}. Tolerant:
 * accepts a JSON object embedded in prose, clamps the three axes to [0,1], and
 * defaults a missing rationale to empty. Returns null when no usable scores are
 * present (caller then leaves the block estimate untouched).
 */
export function coerceTaskEstimate(
  output: string,
  model: string | null,
  now: number,
): TaskEstimate | null {
  const raw = extractJson(output)
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const complexity = clamp01(obj.complexity)
  const risk = clamp01(obj.risk)
  const impact = clamp01(obj.impact)
  if (complexity === null || risk === null || impact === null) return null
  const rationale = typeof obj.rationale === 'string' ? obj.rationale : ''
  return { complexity, risk, impact, rationale, model, createdAt: now }
}

/** A concise markdown summary of an estimate for the step's reviewable output. */
export function summarizeEstimate(estimate: TaskEstimate): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  const header = `**Task estimate** — Complexity ${pct(estimate.complexity)} · Risk ${pct(
    estimate.risk,
  )} · Impact ${pct(estimate.impact)}`
  return estimate.rationale ? `${header}\n\n${estimate.rationale}` : header
}
