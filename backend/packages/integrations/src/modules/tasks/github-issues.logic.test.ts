import { describe, expect, it } from 'vitest'
import {
  buildGitHubIssueSearchQuery,
  detectExactGitHubIssueRef,
  githubIssueUrl,
  parseGitHubIssueExternalId,
  parseGitHubIssueRef,
  parseIssueDependencyLinks,
} from './github-issues.logic.js'

describe('parseIssueDependencyLinks', () => {
  it('parses bare refs against the issue own repo', () => {
    const body = 'Blocked by #12 and #13\nDepends on #99'
    expect(parseIssueDependencyLinks(body, 'octo', 'app')).toEqual([
      { type: 'blockedBy', externalId: 'octo/app#12' },
      { type: 'blockedBy', externalId: 'octo/app#13' },
      { type: 'dependsOn', externalId: 'octo/app#99' },
    ])
  })

  it('parses cross-repo refs and "blocks"', () => {
    expect(parseIssueDependencyLinks('Blocks other/repo#7', 'octo', 'app')).toEqual([
      { type: 'blocks', externalId: 'other/repo#7' },
    ])
  })

  it('attributes each ref on a mixed-direction line to its nearest preceding phrase', () => {
    expect(parseIssueDependencyLinks('Depends on #5 but blocks #9', 'octo', 'app')).toEqual([
      { type: 'dependsOn', externalId: 'octo/app#5' },
      { type: 'blocks', externalId: 'octo/app#9' },
    ])
  })

  it('ignores lines without a recognised phrase and dedupes', () => {
    const body = 'See #5 for context\nblocked by #5\nBlocked by #5'
    expect(parseIssueDependencyLinks(body, 'o', 'r')).toEqual([
      { type: 'blockedBy', externalId: 'o/r#5' },
    ])
  })

  it('returns nothing for an empty body', () => {
    expect(parseIssueDependencyLinks('', 'o', 'r')).toEqual([])
  })
})

describe('parseGitHubIssueRef', () => {
  it('parses a full issue URL', () => {
    expect(parseGitHubIssueRef('https://github.com/octo/my-repo/issues/123')).toBe(
      'octo/my-repo#123',
    )
  })

  it('parses a URL with query/fragment trailing the path', () => {
    expect(parseGitHubIssueRef('https://github.com/octo/my-repo/issues/123#issuecomment-9')).toBe(
      'octo/my-repo#123',
    )
  })

  it('parses the owner/repo#number shorthand', () => {
    expect(parseGitHubIssueRef('octo/my-repo#42')).toBe('octo/my-repo#42')
  })

  it('parses the owner/repo/issues/number path form', () => {
    expect(parseGitHubIssueRef('octo/my-repo/issues/7')).toBe('octo/my-repo#7')
  })

  it('trims surrounding whitespace', () => {
    expect(parseGitHubIssueRef('  octo/my-repo#42  ')).toBe('octo/my-repo#42')
  })

  it('returns null for unparseable input', () => {
    expect(parseGitHubIssueRef('not a ref')).toBeNull()
    expect(parseGitHubIssueRef('octo/my-repo')).toBeNull()
    expect(parseGitHubIssueRef('PROJ-123')).toBeNull()
    expect(parseGitHubIssueRef('octo/my-repo#abc')).toBeNull()
  })
})

describe('parseGitHubIssueExternalId', () => {
  it('round-trips a canonical external id', () => {
    expect(parseGitHubIssueExternalId('octo/my-repo#123')).toEqual({
      owner: 'octo',
      repo: 'my-repo',
      number: 123,
    })
  })

  it('returns null for a malformed id', () => {
    expect(parseGitHubIssueExternalId('octo/my-repo')).toBeNull()
    expect(parseGitHubIssueExternalId('octo#1')).toBeNull()
  })
})

describe('githubIssueUrl', () => {
  it('builds the canonical web URL', () => {
    expect(githubIssueUrl({ owner: 'octo', repo: 'my-repo', number: 9 })).toBe(
      'https://github.com/octo/my-repo/issues/9',
    )
  })
})

describe('buildGitHubIssueSearchQuery', () => {
  const scope = { owner: 'kibertoad', repo: 'simple-service' }

  it('returns the bare query when there is no repo scope', () => {
    expect(buildGitHubIssueSearchQuery('login bug')).toBe('login bug')
  })

  it('prefixes a repo: qualifier when scoped, keeping hits in-repo', () => {
    expect(buildGitHubIssueSearchQuery('login bug', scope)).toBe(
      'repo:kibertoad/simple-service login bug',
    )
  })

  it('yields just the repo qualifier for an empty (number-only) query', () => {
    // The number is handled as an exact ref; the text search degenerates to the repo.
    expect(buildGitHubIssueSearchQuery('', scope)).toBe('repo:kibertoad/simple-service')
  })
})

describe('detectExactGitHubIssueRef', () => {
  const scope = { owner: 'kibertoad', repo: 'simple-service' }

  it('resolves a pasted issue URL to its own repo (scope does not override it)', () => {
    expect(
      detectExactGitHubIssueRef('https://github.com/kibertoad/simple-service/issues/11', scope),
    ).toBe('kibertoad/simple-service#11')
    expect(detectExactGitHubIssueRef('https://github.com/octo/other/issues/3', scope)).toBe(
      'octo/other#3',
    )
  })

  it('resolves a bare issue number against the scoped repo', () => {
    expect(detectExactGitHubIssueRef('11', scope)).toBe('kibertoad/simple-service#11')
    expect(detectExactGitHubIssueRef('  42 ', scope)).toBe('kibertoad/simple-service#42')
  })

  it('does not treat a bare number as an exact ref without a scope', () => {
    expect(detectExactGitHubIssueRef('11')).toBeNull()
  })

  it('returns null for free-text search phrases', () => {
    expect(detectExactGitHubIssueRef('login bug', scope)).toBeNull()
  })
})
