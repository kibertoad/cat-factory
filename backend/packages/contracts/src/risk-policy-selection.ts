import {
  dryRunForcedForRole,
  mergeClassRuleRelaxes,
  resolveRoleScopedMergeClassRule,
  submissionAllowlistForRole,
  type RiskPolicy,
} from './merge.js'
import { RULEABLE_CHANGE_CLASSES } from './mergeTrackRecord.js'
import type { WorkspaceRole } from './workspace-members.js'

// ---------------------------------------------------------------------------
// WHICH merge policy a task may be pointed at, and by whom.
//
// ADR 0037 scopes a preset's merge policy by the workspace role that STARTS a run: `dryRunRoles`
// sandboxes a tier (its runs open a pull request and merge nothing, at either exit) and
// `classRulesByRole` narrows what it may auto-merge. ADR 0039 adds the third,
// `submissionClassesByRole`, allowlisting the change classes a tier may land at all. All three are
// read off the preset the TASK selects, and selecting a task's preset is an ordinary board write
// (`riskPolicyId` on the block patch, `board.write`, member tier). Editing the preset itself is
// admin-gated, so the ADR concluded that a sandboxed member cannot un-sandbox themselves; that was
// half the picture. The other way around a sandbox is not to edit the policy but to point the task
// at a different one: one PATCH, or one click in the inspector's picker.
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
 * The editor's authority, resolvable in ANY workspace rather than fixed to the acting board.
 *
 * A {@link BlockEditActor} is one workspace's answer, and a board write does not always decide in
 * the workspace it was addressed to. A board mounts services homed elsewhere, and every write on
 * one lands at that HOME: the row is written there, its preset id resolves against THAT library,
 * and a run on it is admitted through that board under the role the editor holds THERE. Passing a
 * single pre-resolved actor made the guard compare one workspace's policies against another
 * workspace's roles, which both under- and over-refuses (an admin of the acting board skipped the
 * check on two homes where they are a plain member; a member of the acting board was refused on
 * roles they do not hold anywhere the decision applies).
 *
 * So the entry point supplies the RESOLVER and the guard asks it per workspace it is deciding in.
 * Implementations resolve the acting board for free (the auth gate already published it) and read
 * any other through the same cached membership resolution.
 *
 * A workspace where the editor holds no access at all resolves to {@link UNATTRIBUTED_BLOCK_EDITOR}:
 * they cannot start a run there, so no policy of that workspace can hold or drop anything of theirs.
 */
export interface BlockEditAuthority {
  /** The authority this editor holds in `workspaceId`. */
  in(workspaceId: string): Promise<BlockEditActor>
}

/**
 * The authority of an editor no workspace tier is behind, in every workspace: engine paths, the
 * board scan, an auth-disabled deployment. The {@link UNATTRIBUTED_BLOCK_EDITOR} reading, made
 * total.
 */
export const UNATTRIBUTED_BLOCK_EDIT_AUTHORITY: BlockEditAuthority = {
  in: () => Promise.resolve(UNATTRIBUTED_BLOCK_EDITOR),
}

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
  submissionClassesByRole?: RiskPolicy['submissionClassesByRole'] | null
  /**
   * Whether a run under this preset answers the parks its own automatic loops raise. Unlike its
   * neighbours this one is not ROLE-scoped, and it is here anyway because it is the same kind of
   * capability the rest of this view exists to compare: what a task's governing preset lets a run
   * do WITHOUT a person. Every workspace now seeds an `unattended` built-in whose role layer is
   * empty, so without this arm the picker's other three tests all pass and any member can move a
   * task onto it — removing the human checkpoints their own default raises, with the landing
   * authority unchanged. Optional, and an absent or unrecognised value reads as `attended`, which
   * is what {@link resolvesOwnCaps} does with the same vocabulary and for the same reason.
   */
  autonomy?: RiskPolicy['autonomy'] | null
}

/**
 * Why a preset selection is refused: the machine-readable half, kept apart because the four mean
 * different things to the person holding the picker. The first is about the human checkpoints a
 * run would stop at, the second about a run that would otherwise merge NOTHING, the third about
 * work this tier may not land at all however it is reviewed, and the fourth about review the tier
 * owes on work it may land.
 */
export type RiskPolicySelectionRefusal =
  | 'relaxes_run_oversight'
  | 'relaxes_role_sandbox'
  | 'relaxes_role_submission_allowlist'
  | 'relaxes_role_class_rule'

/**
 * One side of a swap: the policy in force, and the authority the editor holds WHERE it is in force.
 *
 * The two travel together because neither means anything without the other. A preset's role layer
 * is a statement about roles in the workspace that holds it, so reading it against a role the
 * editor holds on some other board answers a question nobody asked. The ordinary same-workspace
 * swap (a picker, a `riskPolicyId` patch) passes the same actor on both sides; a cross-home move
 * passes two, because the editor is a different person to each workspace.
 */
export interface RiskPolicySelectionSide {
  /** The role layer of the preset governing the task on this side, already resolved. */
  policy: RolePolicyView
  /** The authority the editor holds in the workspace this side's policy is in force in. */
  actor: BlockEditActor
}

/**
 * Whether the editor may re-point a task from the `from` side to the `to` side, or the reason they
 * may not.
 *
 * Four ways to pass, and the first three are the reason this is inert on almost every workspace:
 *
 *  - The editor holds no role on the `from` side, so no role-scoped restriction held them there.
 *  - The editor holds no role on the `to` side, so nothing there can be relaxed FOR THEM: with no
 *    tier in that workspace they cannot admit a run under its policy at all. Absent is the
 *    strictest reading, not the weakest, and reading it the other way turns "moved a task into a
 *    service I am not a member of" into a refusal naming a sandbox nobody would have escaped.
 *  - The editor manages the policy library on either side, so the swap grants them nothing they
 *    could not author outright.
 *  - Neither preset's ROLE LAYER holds anything over their role that the other drops.
 *
 * The arms run in the precedence the engine's own merge ladder applies (sandbox, then the
 * submission allowlist, then the class rules), so the reason a picker shows names the same
 * restriction the run would have been refused on.
 *
 * The class arm keys on {@link resolveRoleScopedMergeClassRule}'s `narrowedByRole`, not on the
 * effective rules alone: only a class the role layer ACTUALLY narrowed is a restriction the
 * selector was under. A class where the two presets differ in their BASE rules is a policy about
 * the kind of change, identical for every tier, and refusing that would be the base-policy
 * comparison this rule deliberately does not make. It is the same test `thresholds.roleRule`
 * already applies before blaming a role for a refusal the base map made anyway.
 */
export function refuseRiskPolicySelection(input: {
  from: RiskPolicySelectionSide
  to: RiskPolicySelectionSide
}): RiskPolicySelectionRefusal | null {
  const { from, to } = input
  const heldRole = from.actor.role
  const nextRole = to.actor.role
  if (!heldRole || !nextRole) return null
  if (from.actor.managesPolicy || to.actor.managesPolicy) return null
  // Oversight first, ahead of the merge-ladder arms: the parks this drops are raised while the run
  // is still WORKING, long before anything has a pull request to weigh, so it is the broadest thing
  // a swap can relax and the one a picker should name. Tested with `=== 'unattended'` on the far
  // side and `!== 'unattended'` on the held one, so a value neither member spells reads as attended
  // in both directions: not knowing what a policy says is not a licence to drop a checkpoint.
  if (from.policy.autonomy !== 'unattended' && to.policy.autonomy === 'unattended') {
    return 'relaxes_run_oversight'
  }
  if (
    dryRunForcedForRole(from.policy.dryRunRoles, heldRole) &&
    !dryRunForcedForRole(to.policy.dryRunRoles, nextRole)
  ) {
    return 'relaxes_role_sandbox'
  }
  const heldAllowlist = submissionAllowlistForRole(from.policy.submissionClassesByRole, heldRole)
  if (heldAllowlist) {
    const nextAllowlist = submissionAllowlistForRole(to.policy.submissionClassesByRole, nextRole)
    // An ABSENT allowlist on the far side is the widest policy the setting can express, so it
    // relaxes every held one — including the empty allowlist, where the two look alike in the
    // editor and mean opposite things. Otherwise it is the same subset test the arms above make:
    // a class `to` would land that `from` would not is capability this role did not have.
    if (!nextAllowlist) return 'relaxes_role_submission_allowlist'
    if (nextAllowlist.some((changeClass) => !heldAllowlist.includes(changeClass))) {
      return 'relaxes_role_submission_allowlist'
    }
  }
  for (const changeClass of RULEABLE_CHANGE_CLASSES) {
    const held = resolveRoleScopedMergeClassRule({
      rules: from.policy.classRules,
      byRole: from.policy.classRulesByRole,
      role: heldRole,
      changeClass,
    })
    if (!held.narrowedByRole) continue
    const next = resolveRoleScopedMergeClassRule({
      rules: to.policy.classRules,
      byRole: to.policy.classRulesByRole,
      role: nextRole,
      changeClass,
    })
    if (mergeClassRuleRelaxes(held.effective, next.effective)) return 'relaxes_role_class_rule'
  }
  return null
}
