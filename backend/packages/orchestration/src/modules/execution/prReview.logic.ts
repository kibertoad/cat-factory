import type {
  PrReviewAgentOutput,
  PrReviewFinding,
  PrReviewSeverity,
  PrReviewSlice,
} from '@cat-factory/kernel'

// ---------------------------------------------------------------------------
// Pure PR-review helpers: turn the read-only `pr-reviewer` agent's lenient structured
// output into the id-stamped, severity-ordered `step.prReview` state the engine parks on
// and the window renders. No engine state, no IO — unit-tested directly.
// ---------------------------------------------------------------------------

/** Severity ordering, blocker-first, for sorting the aggregated findings. */
const SEVERITY_RANK: Record<PrReviewSeverity, number> = {
  blocker: 0,
  high: 1,
  medium: 2,
  low: 3,
  nit: 4,
}

/** The blocker-first rank of a severity (unknown → medium's rank, matching the fallback). */
export function severityRank(severity: PrReviewSeverity): number {
  return SEVERITY_RANK[severity] ?? SEVERITY_RANK.medium
}

/** The coerced, id-stamped review the engine records onto `step.prReview`. */
export interface CoercedPrReview {
  summary: string | null
  slices: PrReviewSlice[]
  findings: PrReviewFinding[]
}

/**
 * Coerce the reviewer's lenient output into the persisted review shape: mint stable ids for
 * every slice + finding, anchor each finding to the slice that lists its path (first match
 * wins), drop empty slices/findings, and sort the findings blocker-first. Deterministic and
 * total — a missing/degenerate output yields an empty review rather than throwing (the caller
 * then treats a findings-empty review as "nothing to select" and advances).
 */
export function coercePrReview(
  output: PrReviewAgentOutput | undefined,
  mintSliceId: () => string,
  mintFindingId: () => string,
): CoercedPrReview {
  const slices: PrReviewSlice[] = (output?.slices ?? [])
    .map((s) => ({
      title: s.title?.trim() ?? '',
      rationale: s.rationale?.trim() ?? '',
      paths: (s.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0),
    }))
    // A slice with no name AND no paths carries no information — drop it.
    .filter((s) => s.title.length > 0 || s.paths.length > 0)
    .map((s) => ({
      id: mintSliceId(),
      title: s.title || 'Slice',
      rationale: s.rationale,
      paths: s.paths,
    }))

  // path → sliceId (first slice that lists the path wins), so a finding anchors to its slice.
  const sliceByPath = new Map<string, string>()
  for (const slice of slices) {
    for (const path of slice.paths) {
      if (!sliceByPath.has(path)) sliceByPath.set(path, slice.id)
    }
  }

  const findings: PrReviewFinding[] = (output?.findings ?? [])
    .map((f) => ({
      path: f.path?.trim() ?? '',
      line: f.line ?? null,
      side: f.side ?? null,
      severity: f.severity,
      category: f.category,
      title: f.title?.trim() ?? '',
      detail: f.detail?.trim() ?? '',
      suggestedFix: f.suggestedFix?.trim() || null,
    }))
    // A finding with no headline AND no detail is noise — drop it.
    .filter((f) => f.title.length > 0 || f.detail.length > 0)
    .map((f) => ({
      id: mintFindingId(),
      sliceId: (f.path && sliceByPath.get(f.path)) ?? null,
      path: f.path,
      line: f.line,
      side: f.side,
      severity: f.severity,
      category: f.category,
      title: f.title || 'Finding',
      detail: f.detail,
      suggestedFix: f.suggestedFix,
    }))
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))

  return { summary: output?.summary?.trim() || null, slices, findings }
}
