import { describe, expect, it } from 'vitest'
import { parsePrUrlRepo } from './reviewTaskTarget.js'

// The repo a pasted PR/MR link names. It decides whether a `review` task's target is refused as
// belonging to another repository, so a shape it fails to parse must yield null (we never claim a
// mismatch we cannot see) rather than a partial guess.
describe('parsePrUrlRepo', () => {
  it('reads owner/repo from a GitHub PR url', () => {
    expect(parsePrUrlRepo('https://github.com/o/r/pull/123')).toEqual({ owner: 'o', repo: 'r' })
  })

  it('reads it from a self-hosted host and a trailing path', () => {
    expect(parsePrUrlRepo('https://ghe.corp.example/team/svc/pull/7/files')).toEqual({
      owner: 'team',
      repo: 'svc',
    })
  })

  it('keeps a nested GitLab namespace whole', () => {
    expect(parsePrUrlRepo('https://gitlab.com/group/sub/svc/-/merge_requests/9')).toEqual({
      owner: 'group/sub',
      repo: 'svc',
    })
  })

  it('strips a `.git` suffix so a clone-shaped link still compares equal', () => {
    expect(parsePrUrlRepo('https://github.com/o/r.git/pull/1')).toEqual({ owner: 'o', repo: 'r' })
  })

  it('returns null for anything that is not a PR/MR url', () => {
    expect(parsePrUrlRepo('https://github.com/o/r')).toBeNull()
    expect(parsePrUrlRepo('#42')).toBeNull()
    expect(parsePrUrlRepo('https://github.com/pull/12')).toBeNull()
  })
})
