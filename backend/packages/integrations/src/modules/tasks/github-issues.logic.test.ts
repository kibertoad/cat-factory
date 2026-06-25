import { describe, expect, it } from 'vitest'
import {
  buildGitHubIssueSearchQuery,
  detectExactGitHubIssueRef,
  githubIssueUrl,
  parseGitHubIssueExternalId,
  parseGitHubIssueRef,
} from './github-issues.logic.js'

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
