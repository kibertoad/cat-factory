import { describe, expect, it } from 'vitest'
import * as v from 'valibot'
import {
  dryRunForcedForRole,
  narrowMergeClassRule,
  submissionAllowedForRole,
  submissionAllowlistForRole,
  submissionClassesByRoleSchema,
  type SubmissionClassesByRole,
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

describe('submissionAllowlistForRole', () => {
  it('returns the entry when the preset scopes that role', () => {
    expect(submissionAllowlistForRole({ member: ['docs'] }, 'member')).toEqual(['docs'])
  })

  it('returns nothing for a role the preset left unscoped, and for an unattributed run', () => {
    expect(submissionAllowlistForRole({ member: ['docs'] }, 'admin')).toBeUndefined()
    expect(submissionAllowlistForRole({ member: ['docs'] }, null)).toBeUndefined()
    expect(submissionAllowlistForRole(undefined, 'member')).toBeUndefined()
  })

  // An EMPTY allowlist is a real policy (this role lands nothing), not the absence of one, so it
  // must come back as a list rather than as `undefined`, because the caller distinguishes them.
  it('distinguishes an empty allowlist from an absent one', () => {
    expect(submissionAllowlistForRole({ member: [] }, 'member')).toEqual([])
  })
})

describe('submissionAllowedForRole', () => {
  it('permits a class the role allowlists and refuses one it does not', () => {
    const byRole: SubmissionClassesByRole = { member: ['docs', 'dependency'] }
    expect(submissionAllowedForRole(byRole, 'member', 'docs')).toBe(true)
    expect(submissionAllowedForRole(byRole, 'member', 'dependency')).toBe(true)
    expect(submissionAllowedForRole(byRole, 'member', 'source')).toBe(false)
    expect(submissionAllowedForRole(byRole, 'member', 'schema')).toBe(false)
  })

  // Silence is not an empty allowlist. Only a role somebody wrote an entry for is scoped, so `{}`
  // has to stay the identity, or authoring one role's policy would bar every other role.
  it('leaves an unscoped role, and an unattributed run, unrestricted', () => {
    expect(submissionAllowedForRole({ member: ['docs'] }, 'admin', 'schema')).toBe(true)
    expect(submissionAllowedForRole({ member: ['docs'] }, null, 'schema')).toBe(true)
    expect(submissionAllowedForRole({}, 'member', 'schema')).toBe(true)
    expect(submissionAllowedForRole(undefined, 'member', 'schema')).toBe(true)
    expect(submissionAllowedForRole(null, 'member', 'schema')).toBe(true)
  })

  it('refuses everything for a role scoped to an EMPTY allowlist', () => {
    expect(submissionAllowedForRole({ member: [] }, 'member', 'docs')).toBe(false)
    expect(submissionAllowedForRole({ member: [] }, 'member', 'source')).toBe(false)
  })

  // The opposite direction from the allowlist rule above, and deliberately so: a class we never
  // heard of is a policy gap (refuse), a class we could not READ is an outage (do not refuse).
  it('is inert on `unknown`, even for a role scoped to nothing at all', () => {
    expect(submissionAllowedForRole({ member: ['docs'] }, 'member', 'unknown')).toBe(true)
    expect(submissionAllowedForRole({ member: [] }, 'member', 'unknown')).toBe(true)
  })
})

describe('submissionClassesByRoleSchema', () => {
  it('accepts a partial map of ruleable classes, and the identity', () => {
    expect(v.parse(submissionClassesByRoleSchema, {})).toEqual({})
    expect(v.parse(submissionClassesByRoleSchema, { viewer: ['docs', 'test'] })).toEqual({
      viewer: ['docs', 'test'],
    })
  })

  it('rejects `unknown` as an allowlist member, and an unrecognised role key', () => {
    // `unknown` must stay inert at BOTH tiers: an allowlist that could name it would let an
    // operator author a policy about a diff nobody could read.
    expect(() => v.parse(submissionClassesByRoleSchema, { member: ['unknown'] })).toThrow()
    expect(() => v.parse(submissionClassesByRoleSchema, { maintainer: ['docs'] })).toThrow()
  })
})
