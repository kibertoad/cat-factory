import { describe, expect, it } from 'vitest'
import {
  dryRunForcedForRole,
  mergeClassRuleRelaxes,
  narrowMergeClassRule,
  resolveMergeClassRule,
  resolveRoleScopedMergeClassRule,
} from './merge.js'

describe('narrowMergeClassRule', () => {
  it('takes the stricter of the two rules, in either argument order', () => {
    expect(narrowMergeClassRule('always', 'never')).toBe('never')
    expect(narrowMergeClassRule('never', 'always')).toBe('never')
    expect(narrowMergeClassRule('always', 'thresholds')).toBe('thresholds')
    expect(narrowMergeClassRule('thresholds', 'always')).toBe('thresholds')
    expect(narrowMergeClassRule('thresholds', 'never')).toBe('never')
  })

  it('is idempotent on a pair of equal rules', () => {
    expect(narrowMergeClassRule('always', 'always')).toBe('always')
    expect(narrowMergeClassRule('thresholds', 'thresholds')).toBe('thresholds')
    expect(narrowMergeClassRule('never', 'never')).toBe('never')
  })
})

describe('mergeClassRuleRelaxes', () => {
  it('is true only when the next rule demands LESS review than the one held', () => {
    expect(mergeClassRuleRelaxes('never', 'thresholds')).toBe(true)
    expect(mergeClassRuleRelaxes('never', 'always')).toBe(true)
    expect(mergeClassRuleRelaxes('thresholds', 'always')).toBe(true)
    expect(mergeClassRuleRelaxes('always', 'never')).toBe(false)
    expect(mergeClassRuleRelaxes('thresholds', 'never')).toBe(false)
  })

  it('is false on an unchanged rule, so restating a policy is never a relaxation', () => {
    // What keeps the selection guard from refusing a swap between two presets that say the same
    // thing about this role in different words.
    for (const rule of ['always', 'thresholds', 'never'] as const) {
      expect(mergeClassRuleRelaxes(rule, rule)).toBe(false)
    }
  })
})

describe('dryRunForcedForRole', () => {
  it('sandboxes a role the preset lists', () => {
    expect(dryRunForcedForRole(['member'], 'member')).toBe(true)
    expect(dryRunForcedForRole(['member', 'viewer'], 'viewer')).toBe(true)
  })

  it('leaves a role the preset does not list alone', () => {
    expect(dryRunForcedForRole(['member'], 'admin')).toBe(false)
    expect(dryRunForcedForRole([], 'member')).toBe(false)
  })

  // An unattributed run (schedule fire, public-API start, auth-disabled dev) pins no role, so it
  // can match no entry. Reading absence as the lowest tier would sandbox every scheduled run in a
  // deployment the day it first sandboxes a role.
  it('never sandboxes a run with no pinned role', () => {
    expect(dryRunForcedForRole(['admin', 'member', 'viewer'], null)).toBe(false)
    expect(dryRunForcedForRole(['admin', 'member', 'viewer'], undefined)).toBe(false)
  })

  it('is false when the preset carries no list at all', () => {
    expect(dryRunForcedForRole(undefined, 'member')).toBe(false)
    expect(dryRunForcedForRole(null, 'member')).toBe(false)
  })
})

describe('resolveMergeClassRule', () => {
  it('falls back to thresholds for an absent class or an absent map', () => {
    expect(resolveMergeClassRule({}, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule(undefined, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule(null, 'source')).toBe('thresholds')
    expect(resolveMergeClassRule({ docs: 'always' }, 'source')).toBe('thresholds')
  })

  it('returns the explicit rule for a class that has one', () => {
    expect(resolveMergeClassRule({ docs: 'always' }, 'docs')).toBe('always')
    expect(resolveMergeClassRule({ schema: 'never' }, 'schema')).toBe('never')
    expect(resolveMergeClassRule({ source: 'thresholds' }, 'source')).toBe('thresholds')
  })

  it('NEVER matches a rule for `unknown`, even one somehow stored for it', () => {
    // The load-bearing invariant: a diff we could not read must fall back to the score
    // comparison, so a transient VCS outage can neither widen nor tighten merge policy. The
    // wire schema rejects an `unknown` rule, and this is the second line of defence.
    expect(resolveMergeClassRule({ unknown: 'always' } as never, 'unknown')).toBe('thresholds')
    expect(resolveMergeClassRule({ unknown: 'never' } as never, 'unknown')).toBe('thresholds')
  })
})

describe('resolveRoleScopedMergeClassRule', () => {
  it('is the base rule when no role is pinned', () => {
    // An unattributed run (schedule fire / public API / auth-disabled dev) stays on the policy
    // that governed it before role scoping existed — it is never guessed onto a tier.
    for (const role of [null, undefined]) {
      expect(
        resolveRoleScopedMergeClassRule({
          rules: { docs: 'always' },
          byRole: { viewer: { docs: 'never' } },
          role,
          changeClass: 'docs',
        }),
      ).toEqual({ base: 'always', effective: 'always', narrowedByRole: false })
    }
  })

  it('is the base rule when the pinned role authored nothing', () => {
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { docs: 'always' },
        byRole: { viewer: { docs: 'never' } },
        role: 'admin',
        changeClass: 'docs',
      }),
    ).toEqual({ base: 'always', effective: 'always', narrowedByRole: false })
  })

  it('narrows the base rule for a role that restricts the class', () => {
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { docs: 'always' },
        byRole: { member: { docs: 'never' } },
        role: 'member',
        changeClass: 'docs',
      }),
    ).toEqual({ base: 'always', effective: 'never', narrowedByRole: true })
  })

  it('NEVER widens: a permissive role entry cannot beat a stricter base rule', () => {
    // The safety property of the whole feature. A role allowlist is subtractive, so authoring
    // `always` under a role on a class the preset holds at `thresholds` (or `never`) grants that
    // role nothing — it reads as a mistake and behaves as a no-op, rather than quietly becoming
    // the widest rule in the preset for its least-trusted tier.
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { source: 'never' },
        byRole: { member: { source: 'always' } },
        role: 'member',
        changeClass: 'source',
      }),
    ).toEqual({ base: 'never', effective: 'never', narrowedByRole: false })
    expect(
      resolveRoleScopedMergeClassRule({
        rules: {},
        byRole: { member: { source: 'always' } },
        role: 'member',
        changeClass: 'source',
      }),
    ).toEqual({ base: 'thresholds', effective: 'thresholds', narrowedByRole: false })
  })

  it('reports narrowedByRole only when the ROLE changed the outcome', () => {
    // A role restating the base rule must not be reported as having narrowed it, or the decision
    // banner would blame a role for a refusal the base map made anyway.
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { schema: 'never' },
        byRole: { member: { schema: 'never' } },
        role: 'member',
        changeClass: 'schema',
      }),
    ).toEqual({ base: 'never', effective: 'never', narrowedByRole: false })
  })

  it('keeps `unknown` inert through BOTH layers', () => {
    // A diff we could not read falls back to the score comparison whoever started it: neither the
    // base map nor a role entry may reach it.
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { unknown: 'always' } as never,
        byRole: { member: { unknown: 'never' } } as never,
        role: 'member',
        changeClass: 'unknown',
      }),
    ).toEqual({ base: 'thresholds', effective: 'thresholds', narrowedByRole: false })
  })
})

describe('resolveRoleScopedMergeClassRule: absent is not a rule', () => {
  it('does not narrow a class the role left unmentioned while restricting another', () => {
    // The trap this guards: reading a role's SILENCE on a class as `thresholds` would pull every
    // `always` in the base map down the moment a preset gained its first role entry — including
    // for classes, and roles, that entry says nothing about.
    const byRole = { member: { source: 'never' } } as const
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { docs: 'always', source: 'always' },
        byRole,
        role: 'member',
        changeClass: 'docs',
      }),
    ).toEqual({ base: 'always', effective: 'always', narrowedByRole: false })
    // ...while the class it DOES mention is narrowed.
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { docs: 'always', source: 'always' },
        byRole,
        role: 'member',
        changeClass: 'source',
      }),
    ).toEqual({ base: 'always', effective: 'never', narrowedByRole: true })
  })

  it('honours an EXPLICIT `thresholds` from a role as a real narrowing', () => {
    // The other half of the same distinction: written down, `thresholds` is a policy ("this tier
    // gets the score comparison, not the blanket auto-merge") and must bite.
    expect(
      resolveRoleScopedMergeClassRule({
        rules: { dependency: 'always' },
        byRole: { member: { dependency: 'thresholds' } },
        role: 'member',
        changeClass: 'dependency',
      }),
    ).toEqual({ base: 'always', effective: 'thresholds', narrowedByRole: true })
  })
})
