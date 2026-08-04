import { describe, expect, it } from 'vitest'
import { dryRunForcedForRole, narrowMergeClassRule } from './merge.js'

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
