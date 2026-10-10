import type { RiskPolicySelectionRefusal } from '@cat-factory/contracts'
import { apiErrorReason } from '~/composables/api/errors'

/**
 * The translated description for a reparent the backend refused on merge-preset grounds, or
 * `null` when the failure is anything else.
 *
 * A cross-home drag carries a task into another workspace's preset library, which re-decides
 * whether its runs are sandboxed for the mover's role (ADR 0037), so the backend refuses one that
 * would drop a restriction they are under. That refusal is a condition a person can act on, and
 * the backend does not localize prose: it emits the machine-readable `details.reason` and the SPA
 * maps it here, exactly as `usePipelineErrorToast` maps a conflict's. Without this the drag toast
 * showed the raw English `ForbiddenError` message to every locale.
 *
 * The copy is deliberately NOT the picker's `riskPolicy.picker.refused.*`, which is worded for
 * someone holding a control: this person picked no policy at all, and telling them about "the
 * policy you picked" sends them looking for a picker they never touched.
 *
 * Keyed on the contracts union so a renamed reason fails the typecheck rather than silently
 * falling through to the untranslated prose. An unrecognised reason returns `null` and the caller
 * falls back to the backend's own message, which is the honest last resort.
 */
const MOVE_REFUSAL_KEY: Record<RiskPolicySelectionRefusal, string> = {
  relaxes_run_oversight: 'board.toast.moveRefused.relaxes_run_oversight',
  relaxes_role_sandbox: 'board.toast.moveRefused.relaxes_role_sandbox',
  relaxes_role_submission_allowlist: 'board.toast.moveRefused.relaxes_role_submission_allowlist',
  relaxes_role_class_rule: 'board.toast.moveRefused.relaxes_role_class_rule',
}

/** The i18n key for a thrown reparent error's refusal reason, else `null`. */
export function moveRefusalKey(error: unknown): string | null {
  const reason = apiErrorReason(error)
  if (!reason) return null
  return MOVE_REFUSAL_KEY[reason as RiskPolicySelectionRefusal] ?? null
}
