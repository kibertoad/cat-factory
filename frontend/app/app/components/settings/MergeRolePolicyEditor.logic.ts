// Pure state math behind <MergeRolePolicyEditor>: what a preset's ROLE layer currently says, and
// what each edit turns it into.
//
// It lives outside the SFC because the interesting parts are not the happy path. Two of them:
//
//  - **Absent is not a rule.** A role that authored nothing on a class is governed by the base
//    rule, and that silence must survive a round trip through this editor: an edit clears back to
//    an OMISSION rather than writing `thresholds`, and a role left with nothing drops out of the
//    map entirely, so `{}` stays the identity the wire contract says it is.
//  - **Narrow-only.** `narrowMergeClassRule` (contracts, the same implementation the engine
//    applies) takes the stricter of the base and the role rule, so a role rule that is looser than
//    the base does nothing at all. Offering one would tell an operator they had written a policy
//    when they had written a no-op, so the options a row offers are exactly the rules that would
//    change its outcome, plus whatever is already stored.
import {
  MERGE_CLASS_RULES,
  narrowMergeClassRule,
  RULEABLE_CHANGE_CLASSES,
  WORKSPACE_ROLES,
} from '@cat-factory/contracts'
import type {
  ClassRulesByRole,
  MergeClassRule,
  MergeClassRules,
  RuleableChangeClass,
  WorkspaceRole,
} from '~/types/merge'

/** The "this role adds nothing here" selection, stored as an omission. */
export const INHERIT_RULE = '' as const
export type RoleRuleSelection = MergeClassRule | typeof INHERIT_RULE

/** One class's row inside one role's group. */
export interface RoleClassRuleRow {
  changeClass: RuleableChangeClass
  /** What the preset's base `classRules` say for this class (what the row inherits). */
  base: MergeClassRule
  /** The role's own entry, or {@link INHERIT_RULE} when it authored none. */
  selected: RoleRuleSelection
  /**
   * The rules this row may be set to: the ones strictly stricter than `base` (a looser one is
   * discarded by the engine), plus the stored value whatever it is, so a rule that a later base
   * edit turned into a no-op stays visible and clearable instead of vanishing from its own row.
   */
  options: MergeClassRule[]
  /**
   * The stored rule no longer changes anything, because the base rule is already at least as
   * strict. Not an error and not silently dropped: the operator wrote it down, and the honest
   * report is that the base map now covers it.
   */
  redundant: boolean
}

/**
 * The rules that would actually narrow `base`. Empty for `never`, which is already the strictest
 * rule there is, so a class the preset always routes to a human offers a role nothing to add.
 */
export function narrowingOptionsFor(base: MergeClassRule): MergeClassRule[] {
  return MERGE_CLASS_RULES.filter((rule) => narrowMergeClassRule(base, rule) !== base)
}

/** One role's rows, in the shared class order, against the preset's base rules. */
export function roleClassRuleRows(
  base: MergeClassRules,
  entry: MergeClassRules | undefined,
): RoleClassRuleRow[] {
  return RULEABLE_CHANGE_CLASSES.map((changeClass) => {
    const baseRule = base[changeClass] ?? 'thresholds'
    const selected = entry?.[changeClass] ?? INHERIT_RULE
    const options = narrowingOptionsFor(baseRule)
    return {
      changeClass,
      base: baseRule,
      selected,
      options: selected && !options.includes(selected) ? [...options, selected] : options,
      redundant: !!selected && narrowMergeClassRule(baseRule, selected) === baseRule,
    }
  })
}

/**
 * Set (or clear) one role's rule for one class, pruning back to the identity: clearing the last
 * rule a role carried removes the role's entry, so a preset an operator has emptied is byte-for-byte
 * the `{}` a preset that never had a role rule carries.
 */
export function setRoleClassRule(
  byRole: ClassRulesByRole,
  role: WorkspaceRole,
  changeClass: RuleableChangeClass,
  rule: RoleRuleSelection,
): ClassRulesByRole {
  const entry: MergeClassRules = { ...byRole[role] }
  if (rule === INHERIT_RULE) delete entry[changeClass]
  else entry[changeClass] = rule
  const next: ClassRulesByRole = { ...byRole }
  if (Object.keys(entry).length === 0) delete next[role]
  else next[role] = entry
  return next
}

/**
 * Add or remove a role from the sandboxed list, keeping it in the shared role order so two presets
 * carrying the same policy carry the same array (and a diff of a preset reads as an edit rather
 * than a reshuffle).
 */
export function toggleDryRunRole(
  roles: readonly WorkspaceRole[],
  role: WorkspaceRole,
  sandboxed: boolean,
): WorkspaceRole[] {
  const next = new Set(roles)
  if (sandboxed) next.add(role)
  else next.delete(role)
  return WORKSPACE_ROLES.filter((r) => next.has(r))
}

/** How many classes a role has authored a rule for (the collapsed group's summary). */
export function roleNarrowedCount(entry: MergeClassRules | undefined): number {
  return entry ? Object.keys(entry).length : 0
}
