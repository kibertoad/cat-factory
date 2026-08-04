import { describe, expect, it } from 'vitest'
import { MERGE_CLASS_RULES } from '@cat-factory/contracts'
import type { ClassRulesByRole, MergeClassRules } from '~/types/merge'
import {
  INHERIT_RULE,
  narrowingOptionsFor,
  roleClassRuleRows,
  roleNarrowedCount,
  setRoleClassRule,
  toggleDryRunRole,
} from '~/components/settings/MergeRolePolicyEditor.logic'

describe('narrowingOptionsFor', () => {
  it('offers only the rules that would actually narrow the base', () => {
    expect(narrowingOptionsFor('always')).toEqual(['thresholds', 'never'])
    expect(narrowingOptionsFor('thresholds')).toEqual(['never'])
  })

  // Nothing is stricter than "always require review", so the editor has nothing to offer a role
  // on that class rather than an option that silently does nothing.
  it('offers nothing on a class the policy already routes to a human', () => {
    expect(narrowingOptionsFor('never')).toEqual([])
  })
})

// The sentinel is a VALUE the select renders as an item, and Reka UI's `SelectItem` throws on an
// empty-string value (it reserves `''` for "cleared, show the placeholder"). Nothing here can see
// that widget, so the invariant it imposes is asserted where it is authored: the failure it
// prevents is not a wrong label, it is the settings panel throwing when a role group is expanded.
describe('INHERIT_RULE', () => {
  it('is a non-empty value the select can carry as an item', () => {
    expect(INHERIT_RULE).not.toBe('')
    expect(INHERIT_RULE.length).toBeGreaterThan(0)
  })

  // It is also not one of the rules, or clearing a row would be indistinguishable from setting it.
  it('cannot collide with a real rule', () => {
    expect(MERGE_CLASS_RULES).not.toContain(INHERIT_RULE as string)
  })
})

describe('roleClassRuleRows', () => {
  const base: MergeClassRules = { docs: 'always', schema: 'never' }

  // The sentinel is truthy, so anything asking "did this role author a rule" by testing the
  // SELECTION rather than the stored entry reads inheritance as a stored rule: it would offer
  // "same as this policy" twice on every untouched row, and flag every one of them redundant.
  it('never treats inheritance as a stored rule', () => {
    for (const row of roleClassRuleRows(base, undefined)) {
      expect(row.options).not.toContain(INHERIT_RULE as string)
      expect(row.redundant).toBe(false)
    }
  })

  it('reads an absent entry as inheritance, never as thresholds', () => {
    const rows = roleClassRuleRows(base, undefined)
    expect(rows.map((r) => r.selected)).toEqual([
      INHERIT_RULE,
      INHERIT_RULE,
      INHERIT_RULE,
      INHERIT_RULE,
      INHERIT_RULE,
      INHERIT_RULE,
    ])
    expect(rows.find((r) => r.changeClass === 'docs')?.base).toBe('always')
    expect(rows.find((r) => r.changeClass === 'source')?.base).toBe('thresholds')
  })

  it('surfaces the role rule and marks it as governing when it narrows', () => {
    const rows = roleClassRuleRows(base, { docs: 'never' })
    const docs = rows.find((r) => r.changeClass === 'docs')
    expect(docs?.selected).toBe('never')
    expect(docs?.redundant).toBe(false)
  })

  // A base edit can turn a stored role rule into a no-op. The row keeps it (so it can be read and
  // cleared) and says it no longer does anything, rather than dropping it and reading as clean.
  it('keeps a rule the base rule has overtaken, flagged as having no effect', () => {
    const rows = roleClassRuleRows({ docs: 'never' }, { docs: 'thresholds' })
    const docs = rows.find((r) => r.changeClass === 'docs')
    expect(docs?.selected).toBe('thresholds')
    expect(docs?.redundant).toBe(true)
    expect(docs?.options).toContain('thresholds')
  })
})

describe('setRoleClassRule', () => {
  it('writes a rule under the role', () => {
    expect(setRoleClassRule({}, 'member', 'source', 'never')).toEqual({
      member: { source: 'never' },
    })
  })

  it('clears back to an omission, so absent stays absent', () => {
    const before: ClassRulesByRole = { member: { source: 'never', docs: 'never' } }
    expect(setRoleClassRule(before, 'member', 'docs', INHERIT_RULE)).toEqual({
      member: { source: 'never' },
    })
  })

  // `{}` is the identity for the whole feature, so emptying a role's last rule must reach it:
  // a `{ member: {} }` left behind would read as a role that had been given a policy.
  it('drops the role entirely once its last rule is cleared', () => {
    const before: ClassRulesByRole = { admin: { docs: 'never' }, member: { source: 'never' } }
    expect(setRoleClassRule(before, 'member', 'source', INHERIT_RULE)).toEqual({
      admin: { docs: 'never' },
    })
  })

  it('leaves the other roles untouched', () => {
    const before: ClassRulesByRole = { admin: { docs: 'never' } }
    expect(setRoleClassRule(before, 'member', 'source', 'thresholds')).toEqual({
      admin: { docs: 'never' },
      member: { source: 'thresholds' },
    })
  })
})

describe('toggleDryRunRole', () => {
  it('adds and removes a role', () => {
    expect(toggleDryRunRole([], 'member', true)).toEqual(['member'])
    expect(toggleDryRunRole(['member'], 'member', false)).toEqual([])
  })

  it('keeps the shared role order whatever order the toggles arrived in', () => {
    expect(toggleDryRunRole(['viewer'], 'admin', true)).toEqual(['admin', 'viewer'])
    expect(toggleDryRunRole(['viewer', 'admin'], 'member', true)).toEqual([
      'admin',
      'member',
      'viewer',
    ])
  })

  it('is idempotent on a role already in the state asked for', () => {
    expect(toggleDryRunRole(['member'], 'member', true)).toEqual(['member'])
    expect(toggleDryRunRole([], 'member', false)).toEqual([])
  })
})

describe('roleNarrowedCount', () => {
  it('counts the classes a role authored, and reads absence as zero', () => {
    expect(roleNarrowedCount(undefined)).toBe(0)
    expect(roleNarrowedCount({})).toBe(0)
    expect(roleNarrowedCount({ docs: 'never', source: 'never' })).toBe(2)
  })
})
