import type { SandboxExpectation } from '@cat-factory/contracts'

/** Concise builder for a graded expectation; `matchHints` defaults to `[summary]`-matching. */
export function exp(
  id: string,
  summary: string,
  grade: { impact: number; trickiness: number; detail?: string; matchHints?: string[] },
): SandboxExpectation {
  return {
    id,
    summary,
    detail: grade.detail ?? '',
    impact: grade.impact,
    trickiness: grade.trickiness,
    matchHints: grade.matchHints ?? [],
  }
}
