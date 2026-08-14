import { describe, expect, it } from 'vitest'
import type { GitHubIssueSearchHit, IssueIntakeQuery } from '@cat-factory/kernel'
import {
  buildGitLabIntakeSearch,
  buildGitLabIssueSearchQuery,
  detectExactGitLabIssueRef,
  gitlabIssueExternalId,
  gitlabIssueInRepoScope,
  gitlabHitToBugCandidate,
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

describe('gitlabIssueInRepoScope', () => {
  it('keeps an issue of the scoped project and drops a sibling one', () => {
    const scope = { owner: 'acme', repo: 'web' }
    expect(gitlabIssueInRepoScope('acme/web#42', scope)).toBe(true)
    expect(gitlabIssueInRepoScope('acme/api#42', scope)).toBe(false)
    expect(gitlabIssueInRepoScope('other/web#42', scope)).toBe(false)
  })

  it('holds a NESTED namespace whole, so a subgroup is not another group project', () => {
    const scope = { owner: 'acme/platform', repo: 'web' }
    expect(gitlabIssueInRepoScope('acme/platform/web#7', scope)).toBe(true)
    // Same trailing segments, different subgroup: a fold at the FIRST slash would pass this.
    expect(gitlabIssueInRepoScope('acme/tooling/web#7', scope)).toBe(false)
    expect(gitlabIssueInRepoScope('acme/web#7', scope)).toBe(false)
  })

  it('is case-SENSITIVE, because GitLab serves two differently-cased paths as two projects', () => {
    expect(gitlabIssueInRepoScope('Acme/Web#42', { owner: 'acme', repo: 'web' })).toBe(false)
  })

  it('treats an unparseable id as out-of-scope, never in every scope', () => {
    expect(gitlabIssueInRepoScope('not-an-id', { owner: 'acme', repo: 'web' })).toBe(false)
    // A single-segment path names no project, so it names no scope either.
    expect(gitlabIssueInRepoScope('web#42', { owner: 'acme', repo: 'web' })).toBe(false)
  })
})

describe('buildGitLabIntakeSearch', () => {
  const base: IssueIntakeQuery = { board: { gitlabProject: 'group/sub/web' }, limit: 1 }

  it('splits a nested project path at its last slash, the way the client folds a web URL', () => {
    expect(buildGitLabIntakeSearch(base, { limit: 5, page: 1 }).ref).toEqual({
      owner: 'group/sub',
      repo: 'web',
    })
    expect(
      buildGitLabIntakeSearch(
        { ...base, board: { gitlabProject: 'acme/web' } },
        { limit: 5, page: 1 },
      ).ref,
    ).toEqual({ owner: 'acme', repo: 'web' })
  })

  it('pushes every expressible predicate into the request, open and oldest-first', () => {
    const search = buildGitLabIntakeSearch(
      { ...base, labels: ['bug', 'needs triage'], unassignedOnly: true },
      { limit: 20, page: 3 },
    )
    expect(search.query).toEqual({
      openOnly: true,
      order: 'created-asc',
      limit: 20,
      page: 3,
      labels: ['bug', 'needs triage'],
      unassignedOnly: true,
    })
  })

  // GitLab's `search` covers the description too, so an intake configured on a title fragment
  // would otherwise start a pipeline on an issue that merely mentions it in its body.
  it('narrows a title fragment to the title rather than searching the body as well', () => {
    const search = buildGitLabIntakeSearch(
      { ...base, titleFragment: 'crash on save' },
      { limit: 5, page: 1 },
    )
    expect(search.query.text).toBe('crash on save')
    expect(search.query.textIn).toBe('title')
  })

  // GitLab's own issue-type vocabulary has no member meaning "bug", and the intake default IS
  // `bug`; sending it would be rejected by the API outright.
  it('ignores an issue type rather than sending one GitLab cannot express', () => {
    const search = buildGitLabIntakeSearch({ ...base, issueType: 'bug' }, { limit: 5, page: 1 })
    expect(search.query).not.toHaveProperty('issueType')
    expect(search.query).not.toHaveProperty('text')
  })

  it('omits the page parameter on the first page', () => {
    expect(buildGitLabIntakeSearch(base, { limit: 5, page: 1 }).query).not.toHaveProperty('page')
  })

  // A board that names no project must refuse, not reach GitLab and come back as an empty board.
  it('refuses a missing board and one that does not name a project', () => {
    expect(() => buildGitLabIntakeSearch({ board: {}, limit: 1 }, { limit: 5, page: 1 })).toThrow(
      /no project configured/i,
    )
    for (const board of ['web', 'group/', '/web', 'group/we b']) {
      expect(() =>
        buildGitLabIntakeSearch(
          { board: { gitlabProject: board }, limit: 1 },
          { limit: 5, page: 1 },
        ),
      ).toThrow(/not a GitLab project scope/i)
    }
  })
})

describe('gitlabHitToBugCandidate', () => {
  const hit: GitHubIssueSearchHit = {
    owner: 'group/sub',
    repo: 'web',
    number: 9,
    title: 'Crash',
    state: 'open',
    url: 'https://git.acme.io/group/sub/web/-/issues/9',
    body: '  steps to reproduce  ',
    labels: ['bug'],
    createdAt: '2026-01-02T03:04:05Z',
    commentCount: 4,
  }

  it('reads every field off the SAME response, so a scan needs no per-candidate fetch', () => {
    expect(gitlabHitToBugCandidate(hit)).toEqual({
      source: 'gitlab',
      externalId: 'group/sub/web#9',
      title: 'Crash',
      url: 'https://git.acme.io/group/sub/web/-/issues/9',
      status: 'open',
      type: '',
      priority: null,
      labels: ['bug'],
      description: 'steps to reproduce',
      createdAt: '2026-01-02T03:04:05Z',
      commentCount: 4,
    })
  })

  // Priority and type are per-instance label conventions on GitLab; reading one instance's onto
  // every deployment would report a priority nobody set.
  it('states an absent body/labels/age as empty rather than guessing a priority or type', () => {
    const bare = gitlabHitToBugCandidate({ ...hit, body: undefined, labels: undefined })
    expect(bare.description).toBe('')
    expect(bare.labels).toEqual([])
    expect(bare.priority).toBeNull()
    expect(bare.type).toBe('')
  })
})
