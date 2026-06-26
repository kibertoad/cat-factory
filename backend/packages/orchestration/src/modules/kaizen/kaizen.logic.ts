import type { KaizenGrading, KaizenVerifiedCombo } from '@cat-factory/contracts'

// Pure Kaizen decision logic — no I/O, no clock, no LLM. Kept separate from the
// service so the streak/verification rules are unit-testable in isolation.

/** The grade (on the 1..5 scale) at or above which a grading counts as "high". */
export const HIGH_GRADE = 5

/** Consecutive high-grade-with-no-recommendations gradings needed to verify a combo. */
export const VERIFICATION_STREAK = 5

/** `agentKind|model|promptVersion` — the key a verified combo is tracked under. */
export function comboKeyFor(agentKind: string, model: string, promptVersion: number): string {
  return `${agentKind}|${model}|${promptVersion}`
}

/**
 * Whether a completed grading is a "high grade": top score AND no recommendations.
 * Both conditions are required — a 5 with a recommendation still means there's
 * something to improve, so it does not advance the verification streak.
 */
export function isHighGrade(grade: number | null, recommendations: readonly string[]): boolean {
  return grade != null && grade >= HIGH_GRADE && recommendations.length === 0
}

/**
 * The combo's next verification state after folding in one completed grading.
 * A high grade increments the streak (and flips `verified` once it reaches
 * {@link VERIFICATION_STREAK}); anything else resets the streak to 0. Once verified,
 * a combo stays verified (the engine stops scheduling gradings for it, so no further
 * grading should arrive — but if one does, re-evaluate from the same rules).
 *
 * `prev` is null for a combo's first-ever grading.
 */
export function nextComboState(
  prev: KaizenVerifiedCombo | null,
  grading: Pick<
    KaizenGrading,
    'comboKey' | 'agentKind' | 'model' | 'promptVersion' | 'grade' | 'recommendations'
  >,
  now: number,
): KaizenVerifiedCombo {
  const high = isHighGrade(grading.grade, grading.recommendations)
  const priorStreak = prev?.consecutiveHighGrades ?? 0
  const consecutiveHighGrades = high ? priorStreak + 1 : 0
  const verified = consecutiveHighGrades >= VERIFICATION_STREAK
  const verifiedAt = verified ? (prev?.verifiedAt ?? now) : null
  return {
    comboKey: grading.comboKey,
    agentKind: grading.agentKind,
    model: grading.model,
    promptVersion: grading.promptVersion,
    consecutiveHighGrades,
    verified,
    verifiedAt,
    updatedAt: now,
  }
}

/** Whether a combo is verified and should therefore NOT be graded again. */
export function isVerified(combo: KaizenVerifiedCombo | null): boolean {
  return combo?.verified === true
}
