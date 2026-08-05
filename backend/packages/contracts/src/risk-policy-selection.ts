import {
  dryRunForcedForRole,
  mergeClassRuleRelaxes,
  resolveRoleScopedMergeClassRule,
  type RiskPolicy,
} from './merge.js'
import { RULEABLE_CHANGE_CLASSES } from './mergeTrackRecord.js'
import type { WorkspaceRole } from './workspace-members.js'

// ---------------------------------------------------------------------------
// WHICH merge policy a task may be pointed at, and by whom.
//
// ADR 0037 scopes a preset's merge policy by the workspace role that STARTS a run: `dryRunRoles`
// sandboxes a tier (its runs open a pull request and merge nothing, at either exit) and
// `classRulesByRole` narrows what it may auto-merge. Both are read off the preset the TASK
// selects, and selecting a task's preset is an ordinary board write (`riskPolicyId` on the block
// patch, `board.write`, member tier). Editing the preset itself is admin-gated, so the ADR
// concluded that a sandboxed member cannot un-sandbox themselves; that was half the picture. The
// other way around a sandbox is not to edit the policy but to point the task at a different one:
// one PATCH, or one click in the inspector's picker.
//
// The rule below closes that, and it is the NARROW-ONLY property the role layer is already built
// on, applied to SELECTION rather than to authoring: a selection may not drop a restriction the
// selector's own role was under.
//
// What it deliberately does NOT compare is the two presets' BASE policy: the score ceilings,
// `autoMergeEnabled`, the un-scoped `classRules`. Those say the same thing to every tier, so
// moving a task between them is the ordinary per-task policy choice the preset library exists to
// offer; refusing it would make preset selection admin-only through the back door, and would do
// it on deployments that never authored a role policy at all. The consequence worth stating: on
// a workspace whose presets treat every initiator alike (which is every built-in), this rule
// cannot refuse anything, and the selection behaves byte-for-byte as it did before.
//
// In contracts rather than in kernel because the SPA has to agree about the answer: the picker
// disables an option the engine would refuse, rather than offering it and handing back a 403.
// ---------------------------------------------------------------------------

/**
 * Who is editing a block, as each entry point already knows it.
 *
 * Two facts, because a swap is judged against the editor rather than against the board: the tier
 * whose restrictions could be dropped, and whether they own the policy library in the first place.
 */
export interface BlockEditActor {
  /**
   * The workspace role the auth gate resolved, or `null` when the caller holds no tier at all:
   * an internal reconciliation (the board scan), a headless `/api/v1` key (which carries scopes,
   * not membership) or auth-disabled dev. That absence is a REAL state and is never read as the
   * lowest tier, the same call {@link dryRunForcedForRole} and `initiatedByRole` make: a caller
   * with no role matches no role entry, so no role-scoped restriction can be dropped by one.
   */
  role: WorkspaceRole | null
  /**
   * Whether the editor holds `settings.manage`, the permission that owns the preset library.
   * Someone who can rewrite `dryRunRoles` cannot escalate by SELECTING a preset, so refusing them
   * a swap would be theatre with a support ticket attached.
   */
  managesPolicy: boolean
}

/**
 * The editor of a block change that no workspace tier is behind. See {@link BlockEditActor.role}:
 * this passes the selection rule because there is no role whose restrictions could be dropped,
 * NOT because the caller was granted anything.
 */
export const UNATTRIBUTED_BLOCK_EDITOR: BlockEditActor = { role: null, managesPolicy: false }

/**
 * The half of a preset that speaks about WHO started the run. Both sides of a swap are supplied
 * already RESOLVED (a task that pins no preset is governed by the workspace default, so that is
 * what its side of the comparison must be), because the two callers resolve it differently: the
 * engine through the preset repository, the SPA through its preset store.
 *
 * Every member is optional because the built-in fallback policy the engine resolves to when a
 * workspace has seeded no library carries none of them, and that absence is the identity: no
 * role is sandboxed, no class is narrowed for anyone.
 */
export interface RolePolicyView {
  classRules?: RiskPolicy['classRules'] | null
  classRulesByRole?: RiskPolicy['classRulesByRole'] | null
  dryRunRoles?: readonly WorkspaceRole[] | null
}

/**
 * Why a preset selection is refused: the machine-readable half, kept apart because the two mean
 * different things to the person holding the picker (and because only the first is about a run
 * that would otherwise merge NOTHING).
 */
export type RiskPolicySelectionRefusal = 'relaxes_role_sandbox' | 'relaxes_role_class_rule'

/**
 * Whether `actor` may re-point a task from the `from` policy to the `to` policy, or the reason
 * they may not.
 *
 * Three ways to pass, and the first two are the reason this is inert on almost every workspace:
 *
 *  - The actor holds no workspace role, so no role-scoped restriction applies to them.
 *  - The actor manages the policy library, so a swap grants them nothing they could not author.
 *  - Neither preset's ROLE LAYER holds anything over this role that the other drops.
 *
 * The class arm keys on {@link resolveRoleScopedMergeClassRule}'s `narrowedByRole`, not on the
 * effective rules alone: only a class the role layer ACTUALLY narrowed is a restriction the
 * selector was under. A class where the two presets differ in their BASE rules is a policy about
 * the kind of change, identical for every tier, and refusing that would be the base-policy
 * comparison this rule deliberately does not make. It is the same test `thresholds.roleRule`
 * already applies before blaming a role for a refusal the base map made anyway.
 */
export function refuseRiskPolicySelection(input: {
  from: RolePolicyView
  to: RolePolicyView
  actor: BlockEditActor
}): RiskPolicySelectionRefusal | null {
  const { from, to, actor } = input
  const role = actor.role
  if (!role || actor.managesPolicy) return null
  if (dryRunForcedForRole(from.dryRunRoles, role) && !dryRunForcedForRole(to.dryRunRoles, role)) {
    return 'relaxes_role_sandbox'
  }
  for (const changeClass of RULEABLE_CHANGE_CLASSES) {
    const held = resolveRoleScopedMergeClassRule({
      rules: from.classRules,
      byRole: from.classRulesByRole,
      role,
      changeClass,
    })
    if (!held.narrowedByRole) continue
    const next = resolveRoleScopedMergeClassRule({
      rules: to.classRules,
      byRole: to.classRulesByRole,
      role,
      changeClass,
    })
    if (mergeClassRuleRelaxes(held.effective, next.effective)) return 'relaxes_role_class_rule'
  }
  return null
}
