import type { KaizenGrading, KaizenVerifiedCombo } from '@cat-factory/contracts'

// Pure Kaizen decision logic — no I/O, no clock, no LLM. Kept separate from the
// service so the streak/verification rules are unit-testable in isolation.

/** The grade (on the 1..5 scale) at or above which a grading counts as "high". */
export const HIGH_GRADE = 4

/** Consecutive high-grade-with-no-recommendations gradings needed to verify a combo. */
export const VERIFICATION_STREAK = 5

/** `agentKind|model|promptVersion` — the key a verified combo is tracked under. */
export function comboKeyFor(agentKind: string, model: string, promptVersion: number): string {
  return `${agentKind}|${model}|${promptVersion}`
}

/**
 * Whether a completed grading is a "high grade": a strong score AND no recommendations.
 * The no-recommendations gate is the real quality signal — the grader found nothing to
 * improve — so a grading with ANY recommendation does not advance the streak regardless of
 * its number. Requiring a *flawless* 5 every time made the streak almost never converge
 * (so the "stop grading a verified combo" optimization never engaged and good combos were
 * re-graded on every run forever); a 4-or-5 with nothing to improve is the intended bar.
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
