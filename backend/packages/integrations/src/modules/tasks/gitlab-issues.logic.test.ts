import { describe, expect, it } from 'vitest'
import {
  buildGitLabIssueSearchQuery,
  detectExactGitLabIssueRef,
  gitlabIssueExternalId,
  gitlabIssueUrl,
  gitlabWebBaseFromApiBase,
  parseGitLabIssueExternalId,
  parseGitLabIssueRef,
} from './gitlab-issues.logic.js'

describe('parseGitLabIssueRef', () => {
  it('parses an issue URL on any host, including a self-managed one', () => {
    expect(parseGitLabIssueRef('https://gitlab.com/acme/web/-/issues/12')).toBe('acme/web#12')
    expect(parseGitLabIssueRef('https://git.acme.io/acme/web/-/issues/12')).toBe('acme/web#12')
  })

  it('parses the path and shorthand forms', () => {
    expect(parseGitLabIssueRef('acme/web/-/issues/12')).toBe('acme/web#12')
    expect(parseGitLabIssueRef('  acme/web#12  ')).toBe('acme/web#12')
  })

  // The whole reason this grammar is not the GitHub one: a subgroup path must survive the
  // round trip, rather than being read as garbage by a parser expecting exactly two segments.
  it('keeps a nested subgroup path intact, in every accepted form', () => {
    expect(parseGitLabIssueRef('https://gitlab.com/group/sub/deeper/web/-/issues/7')).toBe(
      'group/sub/deeper/web#7',
    )
    expect(parseGitLabIssueRef('group/sub/web/-/issues/7')).toBe('group/sub/web#7')
    expect(parseGitLabIssueRef('group/sub/web#7')).toBe('group/sub/web#7')
  })

  it('refuses input that names no project or no issue', () => {
    expect(parseGitLabIssueRef('web#12')).toBeNull() // no namespace
    expect(parseGitLabIssueRef('acme/web')).toBeNull() // no issue number
    expect(parseGitLabIssueRef('https://gitlab.com/acme/web/-/merge_requests/12')).toBeNull()
    expect(parseGitLabIssueRef('')).toBeNull()
  })
})

describe('external id round trip', () => {
  it('splits a nested path at its LAST slash, the same fold the client applies to a web URL', () => {
    expect(parseGitLabIssueExternalId('group/sub/web#7')).toEqual({
      owner: 'group/sub',
      repo: 'web',
      number: 7,
    })
  })

  it('round-trips every ref form back to the id it was parsed from', () => {
    for (const ref of ['acme/web#12', 'group/sub/deeper/web#7']) {
      const parsed = parseGitLabIssueExternalId(ref)!
      expect(gitlabIssueExternalId(parsed)).toBe(ref)
    }
  })

  it('returns null for a malformed id rather than throwing', () => {
    expect(parseGitLabIssueExternalId('nonsense')).toBeNull()
    expect(parseGitLabIssueExternalId('web#12')).toBeNull()
  })
})

describe('gitlabIssueUrl', () => {
  it('builds the /-/issues/ path against the deployment web base', () => {
    expect(
      gitlabIssueUrl({ owner: 'group/sub', repo: 'web', number: 7 }, 'https://git.acme.io/'),
    ).toBe('https://git.acme.io/group/sub/web/-/issues/7')
  })

  // A wrong link is worse than no link here: it points at a stranger's instance.
  it('withholds the URL entirely when no web base is known', () => {
    expect(gitlabIssueUrl({ owner: 'acme', repo: 'web', number: 7 }, undefined)).toBe('')
  })
})

describe('gitlabWebBaseFromApiBase', () => {
  it('strips the REST prefix from the configured API base', () => {
    expect(gitlabWebBaseFromApiBase('https://git.acme.io/api/v4')).toBe('https://git.acme.io')
    expect(gitlabWebBaseFromApiBase('https://git.acme.io/api/v4/')).toBe('https://git.acme.io')
  })

  it('answers undefined for an absent base rather than a guess', () => {
    expect(gitlabWebBaseFromApiBase(undefined)).toBeUndefined()
    expect(gitlabWebBaseFromApiBase('   ')).toBeUndefined()
  })
})

describe('buildGitLabIssueSearchQuery', () => {
  it('carries the text as a request predicate and never a scope qualifier', () => {
    expect(buildGitLabIssueSearchQuery('  crash on save ', 20)).toEqual({
      limit: 20,
      text: 'crash on save',
    })
  })

  // An empty box means "this project's issues", not "no filter across the instance": the scope
  // is the ref argument, so an absent text simply drops the only predicate there is.
  it('omits the text predicate for an empty query', () => {
    expect(buildGitLabIssueSearchQuery('   ', 20)).toEqual({ limit: 20 })
  })
})

describe('detectExactGitLabIssueRef', () => {
  const scope = { owner: 'group/sub', repo: 'web' }

  it('resolves a bare number against the scoped project', () => {
    expect(detectExactGitLabIssueRef('42', scope)).toBe('group/sub/web#42')
  })

  it('resolves a URL or shorthand naming the scoped project', () => {
    expect(detectExactGitLabIssueRef('https://gitlab.com/group/sub/web/-/issues/42', scope)).toBe(
      'group/sub/web#42',
    )
    expect(detectExactGitLabIssueRef('group/sub/web#42', scope)).toBe('group/sub/web#42')
  })

  // A stray paste must never be dressed up as a hit the scoped search found.
  it('refuses a reference naming another project', () => {
    expect(detectExactGitLabIssueRef('other/web#42', scope)).toBeNull()
    expect(detectExactGitLabIssueRef('group/web#42', scope)).toBeNull()
  })

  it('treats free text as free text', () => {
    expect(detectExactGitLabIssueRef('crash on save', scope)).toBeNull()
  })
})
