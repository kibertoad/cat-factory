import type { KaizenGrading, KaizenVerifiedCombo } from '@cat-factory/contracts'

// Pure Kaizen decision logic — no I/O, no clock, no LLM. Kept separate from the
// service so the streak/verification rules are unit-testable in isolation.

/** The grade (on the 1..5 scale) at or above which a grading counts as "high". */
const HIGH_GRADE = 4

/** Consecutive high-grade-with-no-recommendations gradings needed to verify a combo. */
export const VERIFICATION_STREAK = 5

/**
 * `agentKind|model|promptVersion[|vID@FP][|wN]` — the key a verified combo is tracked under.
 *
 * Two optional suffixes, both naming text `promptVersion` cannot: it numbers the PRODUCT's
 * prompt, and each of these replaces or extends it.
 *
 * - `vID@FP` is the deployment's registered agent-kind VARIANT the step ran under, taken from the
 *   dispatch-time pin (`PipelineStep.promptVariant`). A variant runs the base kind under
 *   different text, so sharing a key with the stock kind would let one's gradings verify the
 *   other. `FP` fingerprints the text the variant actually CONTRIBUTED, because re-registering an
 *   id is a supported way to re-word a variant — keyed on the id alone, a re-wording would
 *   inherit the streak its previous wording earned, which is the very hazard `wN` exists for on
 *   the workspace side. A variant that contributed NOTHING (withdrawn mid-run, or its
 *   replacement displaced by a workspace override with no addition of its own) carries no
 *   fingerprint and so does not enter the key at all: the key describes the text that ran, and
 *   that text is the shipped or workspace prompt alone.
 * - `wN` is the WORKSPACE's agent-prompt revision when the step ran an edited prompt
 *   (`PipelineStep.promptRevision`). Without it a workspace that rewrote a kind's prompt would
 *   share a key with the shipped one, so Kaizen would skip grading text it never graded —
 *   inheriting a verification the shipped prompt earned — and, in the other direction, let an
 *   edit's gradings advance the streak of a prompt that is not running anywhere.
 *
 * Neither suffix ⇒ the shipped prompt, so an unedited workspace keeps the key it always had.
 */
export function comboKeyFor(
  agentKind: string,
  model: string,
  promptVersion: number,
  promptRevision?: number,
  promptVariant?: { id: string; fingerprint?: string },
): string {
  const base = `${agentKind}|${model}|${promptVersion}`
  const varied = promptVariant?.fingerprint
    ? `${base}|v${promptVariant.id}@${promptVariant.fingerprint}`
    : base
  return promptRevision === undefined ? varied : `${varied}|w${promptRevision}`
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
