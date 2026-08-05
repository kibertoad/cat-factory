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
  SubmissionClassesByRole,
  WorkspaceRole,
} from '~/types/merge'

/**
 * The "this role adds nothing here" selection, stored as an OMISSION.
 *
 * It must be a non-empty string, and not because of a style preference: the select this feeds is
 * Nuxt UI's `USelect` over Reka UI, whose `SelectItem` THROWS on an empty-string value (the empty
 * string is how that widget spells "cleared, show the placeholder", so an item may not claim it).
 * A `''` sentinel therefore does not degrade, it takes down the settings panel the moment a role
 * group is expanded. It is a member of the selection union rather than `undefined` for the same
 * reason: the row has to be able to OFFER inheriting as a choice, which is a value.
 */
export const INHERIT_RULE = 'inherit' as const
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
    // The role's own rule, or nothing at all. Held as `undefined` rather than folded into
    // `selected` up front because "did this role author a rule here" is the question the two
    // lines below both ask, and an absent entry is the one answer that is not one of the three
    // rules. Testing the SENTINEL for that would tie them to whatever string it happens to be.
    const stored = entry?.[changeClass]
    const narrowing = narrowingOptionsFor(baseRule)
    return {
      changeClass,
      base: baseRule,
      selected: stored ?? INHERIT_RULE,
      options: stored && !narrowing.includes(stored) ? [...narrowing, stored] : narrowing,
      redundant: !!stored && narrowMergeClassRule(baseRule, stored) === baseRule,
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

// ---------------------------------------------------------------------------
// The per-role SUBMISSION ALLOWLIST: which change classes a role may LAND at all. A third
// setting rather than a fourth rule value, because it answers a different question: a class rule
// decides how much review landing takes, where this decides whether the platform lands it at all,
// and it is refused at BOTH exits, the manual merge included.
//
// The editing shape follows the wire shape's own distinction: an ABSENT entry is unrestricted
// and an EMPTY list is "this role lands nothing", which are different policies. So the row is a
// switch (scoped / not) plus a set of tick boxes, never a set of tick boxes alone. With tick
// boxes alone, "unrestricted" and "lands nothing" would be the same rendered state.
// ---------------------------------------------------------------------------

/** One class's tick box inside one role's allowlist. */
export interface RoleSubmissionRow {
  changeClass: RuleableChangeClass
  allowed: boolean
}

/** Whether this role carries an allowlist at all (as opposed to being unrestricted). */
export function roleSubmissionScoped(
  byRole: SubmissionClassesByRole,
  role: WorkspaceRole,
): boolean {
  return byRole[role] !== undefined
}

/** One role's tick boxes, in the shared class order. Empty rows for an unscoped role. */
export function roleSubmissionRows(entry: readonly RuleableChangeClass[]): RoleSubmissionRow[] {
  return RULEABLE_CHANGE_CLASSES.map((changeClass) => ({
    changeClass,
    allowed: entry.includes(changeClass),
  }))
}

/**
 * Turn the allowlist on or off for a role. Turning it ON seeds the classes that are landable
 * TODAY, which is behaviourally where the role already was, so the operator subtracts from a
 * known state rather than starting from a policy ("lands nothing") they did not ask for.
 *
 * That seeded list is NOT the identity, and deliberately: from here on the role is scoped, so a
 * class the vocabulary gains in a later release falls outside it. Opting in is what earns that.
 */
export function setRoleSubmissionScoped(
  byRole: SubmissionClassesByRole,
  role: WorkspaceRole,
  scoped: boolean,
): SubmissionClassesByRole {
  const next: SubmissionClassesByRole = { ...byRole }
  if (scoped) next[role] = [...RULEABLE_CHANGE_CLASSES]
  else delete next[role]
  return next
}

/**
 * Tick or untick one class for a role that is already scoped, keeping the shared class order so
 * two presets carrying the same policy carry the same array. Unticking the last class leaves an
 * EMPTY list rather than removing the entry: that is the real policy "this role lands nothing",
 * and silently promoting it to unrestricted would be the exact inversion of what was clicked.
 */
export function toggleSubmissionClass(
  byRole: SubmissionClassesByRole,
  role: WorkspaceRole,
  changeClass: RuleableChangeClass,
  allowed: boolean,
): SubmissionClassesByRole {
  const current = new Set(byRole[role] ?? [])
  if (allowed) current.add(changeClass)
  else current.delete(changeClass)
  return { ...byRole, [role]: RULEABLE_CHANGE_CLASSES.filter((c) => current.has(c)) }
}
