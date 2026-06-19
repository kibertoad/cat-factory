import { describe, expect, it } from 'vitest'
import {
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
