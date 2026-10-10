import type { BugCandidate, BugHuntAnalysis, BugHuntCandidate, BugHuntConfidence } from './types.js'

// ---------------------------------------------------------------------------
// The PURE half of the bug hunt: turn a model's raw ranking reply into ranked candidates.
// No ports, no I/O — so the parsing, the scoring and the ordering are unit-testable without
// a model, and the service stays a thin read-assess-join shell.
//
// The governing rule here is that the TRACKER facts and the MODEL's judgement never mix.
// A candidate row is built from the provider's response; the model contributes only an
// assessment, joined on `externalId`. A verdict naming an issue the board didn't return is
// dropped rather than surfaced, because a hallucinated bug is one a human would try to fix.
// ---------------------------------------------------------------------------

/** The 1–5 range both model judgements are clamped into. */
const MIN_RATING = 1
const MAX_RATING = 5

/** Cap on a rationale, so one verbose verdict can't dominate the response. */
const MAX_RATIONALE_CHARS = 400

/**
 * Impact per unit of complexity, rounded to two decimals.
 *
 * Computed here rather than read off the model's reply for two reasons: the ordering must be
 * reproducible for the same judgements, and a model asked for both a ratio and its operands
 * will sometimes return a ratio that contradicts them — at which point the list a human reads
 * is sorted by something the rationale doesn't explain.
 */
export function bugHuntScore(impact: number, complexity: number): number {
  // `clampRating` floors at MIN_RATING (1), which is what makes the division safe — there is no
  // second guard here, because a second guard would suggest the first one might not hold.
  return Math.round((clampRating(impact) / clampRating(complexity)) * 100) / 100
}

/** Clamp a model-supplied rating into 1–5; a non-finite value degrades to the midpoint. */
function clampRating(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return (MIN_RATING + MAX_RATING) / 2
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(n)))
}

/** Coerce a model-supplied confidence; anything unrecognised degrades to the cautious `low`. */
function coerceConfidence(value: unknown): BugHuntConfidence {
  return value === 'high' || value === 'medium' ? value : 'low'
}

/**
 * Parse the ranking reply into `externalId → analysis`, leniently.
 *
 * Accepts either `{ candidates: [...] }` or a bare array, because both shapes come back in
 * practice and neither is wrong enough to throw away a whole assessment over. A row without a
 * usable `externalId` is skipped; ratings and confidence are coerced rather than rejected, so
 * one malformed field costs that field's precision and not the candidate's place in the list.
 * The FIRST verdict for an id wins — a duplicate is the model repeating itself, not revising.
 */
export function parseBugHuntVerdicts(raw: unknown): Map<string, BugHuntAnalysis> {
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { candidates?: unknown } | null)?.candidates)
      ? (raw as { candidates: unknown[] }).candidates
      : []
  const out = new Map<string, BugHuntAnalysis>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const record = row as Record<string, unknown>
    const externalId = typeof record.externalId === 'string' ? record.externalId.trim() : ''
    if (!externalId || out.has(externalId)) continue
    const impact = clampRating(record.impact)
    const complexity = clampRating(record.complexity)
    out.set(externalId, {
      impact,
      complexity,
      score: bugHuntScore(impact, complexity),
      confidence: coerceConfidence(record.confidence),
      rationale:
        typeof record.rationale === 'string'
          ? record.rationale.trim().slice(0, MAX_RATIONALE_CHARS)
          : '',
      recommended: record.recommended === true,
    })
  }
  return out
}

/**
 * Join the assessments onto the tracker's candidates and order them best-first.
 *
 * Matching is case-insensitive on `externalId` because the vendors disagree with themselves
 * about issue-key case (Jira accepts either, Linear's identifiers are upper-case, a model
 * echoing them back normalises unpredictably) — and a case mismatch would silently present a
 * fully-assessed board as entirely unassessed.
 *
 * Ordering: assessed candidates by score descending, ties broken by impact so the more valuable
 * of two equally-cheap fixes leads; then UNASSESSED candidates in the provider's own
 * oldest-first order. Unassessed rows sort last but are never dropped — the human is choosing
 * from the board, not from the model's shortlist, and a candidate the model skipped is exactly
 * the one worth showing as "not assessed".
 */
export function rankBugCandidates(
  candidates: BugCandidate[],
  verdicts: Map<string, BugHuntAnalysis>,
): BugHuntCandidate[] {
  const byLowerId = new Map<string, BugHuntAnalysis>()
  for (const [id, analysis] of verdicts) byLowerId.set(id.toLowerCase(), analysis)

  const rows: BugHuntCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    analysis: byLowerId.get(candidate.externalId.toLowerCase()) ?? null,
  }))

  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const left = a.row.analysis
      const right = b.row.analysis
      if (left && right) {
        if (right.score !== left.score) return right.score - left.score
        if (right.impact !== left.impact) return right.impact - left.impact
        return a.index - b.index
      }
      if (left) return -1
      if (right) return 1
      return a.index - b.index
    })
    .map(({ row }) => row)
}
