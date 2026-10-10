// Pure resolution behind <RiskPolicyPicker>'s detail pane.
//
// Kept out of the SFC because the interesting case is not the happy path: a task can hold a
// `riskPolicyId` naming a policy that has since been DELETED from the workspace library, and
// what the pane shows then has to agree with what the run engine would actually do. The
// riskPolicies store's `resolve()` falls back to the workspace default for both an empty id
// and a dangling one; this mirrors that, so the picker can never tell the user "no risk policy
// configured" about a task the default is quietly governing.
import {
  refuseRiskPolicySelection,
  type BlockEditActor,
  type RiskPolicySelectionRefusal,
} from '@cat-factory/contracts'
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

/**
 * Which of the offered policies this user may not move THIS task to, keyed by option id (`''`
 * for the "workspace default" row), with the reason.
 *
 * A task's policy decides whether its runs are sandboxed for the initiator's role and how their
 * auto-merge is narrowed, so the backend refuses a selection that would relax what the selector's
 * own role is held to (ADR 0037). The picker applies the SAME contracts rule rather than offering
 * a row and handing back a 403: an authoring surface that offers what the engine discards is
 * telling someone they made a choice they did not make.
 *
 * The policy being moved AWAY from is resolved exactly as the engine resolves it: the named
 * option, else the workspace default. That is what makes the same call correct on the create form
 * (nothing picked yet, so the default is what would have governed the task) and in the inspector.
 */
export function refusedRiskPolicySelections(input: {
  options: readonly RiskPolicy[]
  defaultPolicy: RiskPolicy | null
  modelValue: string
  actor: BlockEditActor
}): Map<string, RiskPolicySelectionRefusal> {
  const refusals = new Map<string, RiskPolicySelectionRefusal>()
  const from =
    (input.modelValue ? input.options.find((p) => p.id === input.modelValue) : undefined) ??
    input.defaultPolicy
  if (!from) return refusals
  const judge = (id: string, to: RiskPolicy | null) => {
    if (!to) return
    // The same actor on both sides: a picker only ever offers the library of the ONE workspace the
    // task is homed in, so both policies are in force there and the editor is the same person to
    // each. The two-sided shape exists for the cross-home move, which the picker cannot express.
    const refusal = refuseRiskPolicySelection({
      from: { policy: from, actor: input.actor },
      to: { policy: to, actor: input.actor },
    })
    if (refusal) refusals.set(id, refusal)
  }
  judge('', input.defaultPolicy)
  for (const policy of input.options) judge(policy.id, policy)
  return refusals
}
