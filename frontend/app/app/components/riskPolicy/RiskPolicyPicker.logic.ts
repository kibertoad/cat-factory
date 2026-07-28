// Pure resolution behind <RiskPolicyPicker>'s detail pane.
//
// Kept out of the SFC because the interesting case is not the happy path: a task can hold a
// `riskPolicyId` naming a policy that has since been DELETED from the workspace library, and
// what the pane shows then has to agree with what the run engine would actually do. The
// riskPolicies store's `resolve()` falls back to the workspace default for both an empty id
// and a dangling one; this mirrors that, so the picker can never tell the user "no risk policy
// configured" about a task the default is quietly governing.
import type { RiskPolicy } from '~/types/merge'

export interface RiskPolicyPickerState {
  /** The policy the detail pane renders, or `null` when the workspace has none at all. */
  policy: RiskPolicy | null
  /**
   * True when `policy` is the workspace default standing in for a row that names no live
   * policy of its own — the pane captions it, so the user knows why they are looking at a
   * policy they did not point at.
   */
  viaWorkspaceDefault: boolean
}

export interface RiskPolicyPickerInput {
  /** The policies offered (the workspace's library). */
  options: readonly RiskPolicy[]
  /** The workspace default, resolved by the caller. `null` when the workspace has none. */
  defaultPolicy: RiskPolicy | null
  /** The selected policy id, or `''` for the "workspace default" row. */
  modelValue: string
  /**
   * The row the pointer or keyboard focus is on: an id, `''` for the "workspace default"
   * row, or `undefined` when neither is on a row (fall back to the selection).
   */
  activeId: string | undefined
}

/**
 * Resolve what the detail pane shows: the active row's policy, else the selected one, else
 * the workspace default. An id that resolves to nothing — empty (the explicit "workspace
 * default" row) or dangling (a deleted policy) — takes the default, since that is the policy
 * the task is governed by either way.
 */
export function resolveRiskPolicyPicker(input: RiskPolicyPickerInput): RiskPolicyPickerState {
  const id = input.activeId ?? input.modelValue
  const named = id ? input.options.find((p) => p.id === id) : undefined
  if (named) return { policy: named, viaWorkspaceDefault: false }
  return { policy: input.defaultPolicy, viaWorkspaceDefault: !!input.defaultPolicy }
}
