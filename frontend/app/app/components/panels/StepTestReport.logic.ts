// Pure logic behind the tester panel's REQUIREMENT → EVIDENCE section (the in-app twin of the
// PR verification report's section of the same name).
//
// Kept out of the SFC on the seam `ServiceSpecWindow.logic.ts` / `AppOverlayHost.logic.ts`
// established, so the one rule worth pinning here — that an unrecognised status can never be
// mistaken for a known one — is unit-testable without mounting Nuxt.
import type { RequirementVerdictStatus } from '~/types/domain'

/** How one verdict renders: its translated label and the dot colour beside it. */
export interface VerdictMeta {
  label: string
  color: string
}

/**
 * The colour an UNRECOGNISED status renders in. Deliberately distinct from all three known
 * colours: an unknown status is a contract violation (version skew against a backend that grew
 * a fourth one), not a fourth state, so borrowing `not_covered`'s grey would render "we have no
 * idea" identically to "we didn't check" — precisely the collapse the three-valued verdict
 * exists to prevent. Amber is the same "attention, but not a failure" tone the panel's severity
 * scale already uses for `medium`.
 */
export const UNKNOWN_VERDICT_COLOR = '#f59e0b'

/** Dot colour per known verdict. Exhaustive over the closed union (drift guard tier 2). */
export const VERDICT_COLORS: Record<RequirementVerdictStatus, string> = {
  met: '#22c55e',
  not_met: '#ef4444',
  not_covered: '#64748b',
}

/**
 * Resolve one verdict's presentation. Labels are passed in already translated (this module is
 * pure, so it holds no `t`), which also keeps the catalog keys literal at the call site where
 * the typed-key drift guard can see them.
 *
 * An unrecognised status falls back to the raw code plus {@link UNKNOWN_VERDICT_COLOR}: showing
 * the code is more useful to the person who has to explain the skew than any invented label,
 * and the distinct colour stops it reading as one of the three real answers.
 */
export function resolveVerdictMeta(
  status: RequirementVerdictStatus,
  labels: Record<RequirementVerdictStatus, string>,
): VerdictMeta {
  const color = VERDICT_COLORS[status]
  const label = labels[status]
  if (!color || !label) return { label: status, color: UNKNOWN_VERDICT_COLOR }
  return { label, color }
}
