import { describe, expect, it } from 'vitest'
import { joinRepoPath, normalizeRepoPath, repoPathSegments } from '~/utils/repoPath'

// These two helpers are what lets the bootstrap service-directory field be BROWSED rather than
// only typed: the segments say what the typed path is called and where it sits, and the join
// puts a not-yet-existing name under the folder a person opened in the repo tree. Both have to
// read a hand-typed value the way `normalizeServiceDirectory` will read it server-side, or the
// field composes a path the API then rewrites underneath it.

describe('normalizeRepoPath', () => {
  it('trims surrounding slashes', () => {
    expect(normalizeRepoPath('/services/payments/')).toBe('services/payments')
    expect(normalizeRepoPath('services/payments')).toBe('services/payments')
    expect(normalizeRepoPath('/')).toBe('')
  })
})

describe('repoPathSegments', () => {
  it('folds separators and drops blank / `.` segments', () => {
    expect(repoPathSegments('  packages/./api  ')).toEqual(['packages', 'api'])
    expect(repoPathSegments('/packages//api/')).toEqual(['packages', 'api'])
  })

  it('reads a Windows-shaped path the same way the API will', () => {
    expect(repoPathSegments('packages\\api')).toEqual(['packages', 'api'])
  })

  it('is empty for a path with nothing in it', () => {
    expect(repoPathSegments('')).toEqual([])
    expect(repoPathSegments('   ')).toEqual([])
    expect(repoPathSegments('./')).toEqual([])
  })

  it('KEEPS `..` so a caller can refuse an escaping path', () => {
    expect(repoPathSegments('packages/../../etc')).toEqual(['packages', '..', '..', 'etc'])
  })
})

describe('joinRepoPath', () => {
  it('places a child under a folder', () => {
    expect(joinRepoPath('services', 'payments')).toBe('services/payments')
    expect(joinRepoPath('/services/', 'payments')).toBe('services/payments')
  })

  it('makes the child the whole path at the repo root (no leading slash)', () => {
    expect(joinRepoPath('', 'payments')).toBe('payments')
    expect(joinRepoPath('   ', 'payments')).toBe('payments')
  })
})
