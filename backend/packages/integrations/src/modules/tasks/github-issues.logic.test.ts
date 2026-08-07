import { describe, expect, it } from 'vitest'
import {
  buildGitHubIntakeQuery,
  buildGitHubIssueSearchQuery,
  detectExactGitHubIssueRef,
  githubHitToBugCandidate,
  githubIssueInRepoScope,
  githubIssueUrl,
  githubReposToBoards,
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

  it('refuses a scope that is not a plain owner/repo slug', () => {
    // `repo:` is unquotable, so a slug smuggling a second qualifier would widen the very
    // scope this function exists to enforce — the same guard the intake board gets.
    expect(() =>
      buildGitHubIssueSearchQuery('bug', { owner: 'octo', repo: 'app org:other' }),
    ).toThrow(/owner\/repo/)
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

  it('resolves a pasted issue URL that names the scoped repo', () => {
    expect(
      detectExactGitHubIssueRef('https://github.com/kibertoad/simple-service/issues/11', scope),
    ).toBe('kibertoad/simple-service#11')
    expect(detectExactGitHubIssueRef('kibertoad/simple-service#11', scope)).toBe(
      'kibertoad/simple-service#11',
    )
  })

  it('matches the scoped repo case-insensitively, and returns the scope casing', () => {
    // Repo names are case-preserving but case-insensitive for lookup, so a paste from the
    // address bar must not be rejected over casing — AND must not be echoed back in the
    // casing it was typed in. An external id is persisted verbatim, so returning
    // `Kibertoad/Simple-Service#11` would create a second projection row for the issue the
    // search already knows as `kibertoad/simple-service#11`: one issue, two context keys.
    expect(
      detectExactGitHubIssueRef('https://github.com/Kibertoad/Simple-Service/issues/11', scope),
    ).toBe('kibertoad/simple-service#11')
    expect(detectExactGitHubIssueRef('KIBERTOAD/SIMPLE-SERVICE#11', scope)).toBe(
      'kibertoad/simple-service#11',
    )
  })

  it('does NOT resolve a reference to another repository', () => {
    // The whole point of the scope: a search only ever offers the service's own issues, so a
    // stray paste can't make another repo's issue look like a hit the search found. Linking
    // it is still possible — as an explicit reference, through the import path.
    expect(detectExactGitHubIssueRef('https://github.com/octo/other/issues/3', scope)).toBeNull()
    expect(detectExactGitHubIssueRef('octo/other#3', scope)).toBeNull()
    // Same owner, different repo — a sibling repo is just as out of scope as a stranger's.
    expect(detectExactGitHubIssueRef('kibertoad/other-service#3', scope)).toBeNull()
  })

  it('resolves a bare issue number against the scoped repo', () => {
    expect(detectExactGitHubIssueRef('11', scope)).toBe('kibertoad/simple-service#11')
    expect(detectExactGitHubIssueRef('  42 ', scope)).toBe('kibertoad/simple-service#42')
  })

  it('returns null for free-text search phrases', () => {
    expect(detectExactGitHubIssueRef('login bug', scope)).toBeNull()
  })
})

describe('buildGitHubIntakeQuery', () => {
  it('compiles every predicate into repo-scoped open-issue search text', () => {
    expect(
      buildGitHubIntakeQuery({
        board: { githubRepo: 'octo/app' },
        issueType: 'Bug',
        labels: ['triage', 'needs repro'],
        titleFragment: 'crash on save',
        limit: 5,
      }),
    ).toBe(
      'repo:octo/app is:open type:"Bug" label:"triage" label:"needs repro" in:title "crash on save"',
    )
  })

  it('omits absent predicates but always filters to open issues', () => {
    expect(buildGitHubIntakeQuery({ board: { githubRepo: 'octo/app' }, limit: 5 })).toBe(
      'repo:octo/app is:open',
    )
  })

  it('drops embedded quotes from qualifier values', () => {
    expect(
      buildGitHubIntakeQuery({ board: { githubRepo: 'octo/app' }, labels: ['a"b'], limit: 5 }),
    ).toBe('repo:octo/app is:open label:"ab"')
  })

  it('refuses a query with no repository at all, rather than scanning everything', () => {
    // Intake does not merely display its hit: it imports the issue and starts a pipeline on
    // it. A boardless GitHub search returns whatever the credential can reach — under a PAT,
    // every public repository — so a schedule stored without a repo must fail loudly.
    expect(() => buildGitHubIntakeQuery({ board: {}, limit: 5 })).toThrow(/no repository/)
    expect(() => buildGitHubIntakeQuery({ board: { githubRepo: '  ' }, limit: 5 })).toThrow(
      /no repository/,
    )
  })

  it('pushes the bug hunt unassigned predicate down as no:assignee', () => {
    expect(
      buildGitHubIntakeQuery({ board: { githubRepo: 'octo/app' }, unassignedOnly: true, limit: 5 }),
    ).toBe('repo:octo/app is:open no:assignee')
  })

  it('refuses a board scope that is not a plain owner/repo slug', () => {
    // The `repo:` qualifier is the one value the grammar takes bare, and a hunt's board comes
    // straight from a request body — so a scope carrying a second qualifier must be refused,
    // not searched. Silently contradicting `is:open`/`no:assignee` would return issues the
    // whole surface promises it is not showing.
    for (const board of [
      'octo/app is:closed',
      'octo/app no:assignee org:elsewhere',
      'octo/app"',
      'octo',
      'octo/app/extra',
    ]) {
      expect(() => buildGitHubIntakeQuery({ board: { githubRepo: board }, limit: 5 })).toThrow(
        /owner\/repo/,
      )
    }
  })

  it('accepts the punctuation GitHub actually allows in a repo slug', () => {
    expect(buildGitHubIntakeQuery({ board: { githubRepo: 'octo-org/my.app_v2' }, limit: 5 })).toBe(
      'repo:octo-org/my.app_v2 is:open',
    )
  })
})

describe('githubHitToBugCandidate', () => {
  const hit = {
    owner: 'octo',
    repo: 'app',
    number: 12,
    title: 'Checkout crashes',
    state: 'open',
    url: 'https://github.com/octo/app/issues/12',
    body: 'Steps: click pay.',
    labels: ['bug', 'checkout'],
    createdAt: '2026-01-02T03:04:05Z',
    commentCount: 4,
  }

  it('projects the fields the search response already carries', () => {
    expect(githubHitToBugCandidate(hit)).toEqual({
      source: 'github',
      externalId: 'octo/app#12',
      title: 'Checkout crashes',
      url: 'https://github.com/octo/app/issues/12',
      status: 'open',
      type: '',
      priority: null,
      labels: ['bug', 'checkout'],
      description: 'Steps: click pay.',
      createdAt: '2026-01-02T03:04:05Z',
      commentCount: 4,
    })
  })

  it('degrades an adapter that omits the optional fields to an empty report', () => {
    // The GitLab-backed client projects onto this shape without them; the ranking must then
    // read a vague report and rate it as such, never a fabricated one.
    const thin = { owner: 'octo', repo: 'app', number: 3, title: 'T', state: 'open', url: 'u' }
    expect(githubHitToBugCandidate(thin)).toMatchObject({
      description: '',
      labels: [],
      createdAt: '',
      commentCount: 0,
    })
  })

  it('truncates a body long enough to dominate the ranking prompt', () => {
    const candidate = githubHitToBugCandidate({ ...hit, body: 'x'.repeat(5_000) })
    expect(candidate.description).toHaveLength(1_200)
  })
})

describe('githubReposToBoards', () => {
  it('maps installation repos onto owner/repo-scoped boards', () => {
    expect(
      githubReposToBoards([
        { owner: 'octo', name: 'app' },
        { owner: 'octo', name: 'infra' },
      ]),
    ).toEqual([
      { id: 'octo/app', name: 'app', key: 'octo/app' },
      { id: 'octo/infra', name: 'infra', key: 'octo/infra' },
    ])
  })

  it('drops a repo missing either half of the scope it would produce', () => {
    expect(
      githubReposToBoards([
        { owner: '', name: 'app' },
        { owner: 'octo', name: '' },
      ]),
    ).toEqual([])
  })
})

describe('githubIssueInRepoScope', () => {
  const scope = { owner: 'octo', repo: 'demo' }

  it('keeps an issue of the scoped repo and drops a sibling repo', () => {
    expect(githubIssueInRepoScope('octo/demo#42', scope)).toBe(true)
    expect(githubIssueInRepoScope('octo/other#7', scope)).toBe(false)
    expect(githubIssueInRepoScope('someone/demo#7', scope)).toBe(false)
  })

  it('matches case-insensitively, as GitHub repo names are', () => {
    expect(githubIssueInRepoScope('Octo/Demo#42', scope)).toBe(true)
    expect(githubIssueInRepoScope('octo/demo#42', { owner: 'OCTO', repo: 'DEMO' })).toBe(true)
  })

  it('treats an unparseable id as out-of-scope, never in every scope', () => {
    expect(githubIssueInRepoScope('not-an-id', scope)).toBe(false)
  })
})
