import { describe, expect, it } from 'vitest'
import {
  buildJiraChildrenJql,
  buildJiraIntakeJql,
  isJiraEpicType,
  mapJiraIssueLinks,
  parseJiraBoards,
  parseJiraBugCandidates,
  parseJiraRef,
} from './jira.logic.js'

describe('isJiraEpicType', () => {
  it('matches epic issue types case-insensitively', () => {
    expect(isJiraEpicType('Epic')).toBe(true)
    expect(isJiraEpicType('epic')).toBe(true)
    expect(isJiraEpicType('Story')).toBe(false)
    expect(isJiraEpicType(undefined)).toBe(false)
  })
})

describe('buildJiraChildrenJql', () => {
  it('matches next-gen children and classic epic links, escaping the key', () => {
    expect(buildJiraChildrenJql('PROJ-1')).toContain('parent = "PROJ-1"')
    expect(buildJiraChildrenJql('PROJ-1')).toContain('"Epic Link" = "PROJ-1"')
  })
})

describe('mapJiraIssueLinks', () => {
  it('maps an inward "is blocked by" link to blockedBy', () => {
    const links = [
      {
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        inwardIssue: { key: 'P-2' },
      },
    ]
    expect(mapJiraIssueLinks(links)).toEqual([{ type: 'blockedBy', externalId: 'P-2' }])
  })

  it('maps an outward "blocks" link to blocks', () => {
    const links = [
      {
        type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
        outwardIssue: { key: 'P-3' },
      },
    ]
    expect(mapJiraIssueLinks(links)).toEqual([{ type: 'blocks', externalId: 'P-3' }])
  })

  it('maps an outward "depends on" link to blockedBy (this waits on the other)', () => {
    const links = [
      {
        type: { name: 'Dependency', inward: 'is depended on by', outward: 'depends on' },
        outwardIssue: { key: 'P-9' },
      },
    ]
    expect(mapJiraIssueLinks(links)).toEqual([{ type: 'blockedBy', externalId: 'P-9' }])
  })

  it('maps an inward "is depended on by" link to blocks (the other waits on this)', () => {
    const links = [
      {
        type: { name: 'Dependency', inward: 'is depended on by', outward: 'depends on' },
        inwardIssue: { key: 'P-10' },
      },
    ]
    expect(mapJiraIssueLinks(links)).toEqual([{ type: 'blocks', externalId: 'P-10' }])
  })

  it('records an unrecognised relation as relates and tolerates junk', () => {
    expect(
      mapJiraIssueLinks([
        {
          type: { name: 'Relates', inward: 'relates to', outward: 'relates to' },
          inwardIssue: { key: 'P-4' },
        },
      ]),
    ).toEqual([{ type: 'relates', externalId: 'P-4' }])
    expect(mapJiraIssueLinks(null)).toEqual([])
    expect(mapJiraIssueLinks([{}])).toEqual([])
  })
})

describe('parseJiraRef (sanity)', () => {
  it('still resolves a bare key', () => {
    expect(parseJiraRef('proj-12')).toBe('PROJ-12')
  })
})

describe('buildJiraIntakeJql', () => {
  it('compiles every predicate into one open-issues query, oldest first', () => {
    const jql = buildJiraIntakeJql({
      board: { jiraProjectKey: 'PROJ' },
      issueType: 'Bug',
      labels: ['triage', 'backend'],
      titleFragment: 'crash',
      limit: 5,
    })
    expect(jql).toBe(
      'project = "PROJ" AND statusCategory != Done AND issuetype = "Bug" AND ' +
        'labels = "triage" AND labels = "backend" AND summary ~ "crash" ORDER BY created ASC',
    )
  })

  it('omits absent predicates but always filters to open issues', () => {
    expect(buildJiraIntakeJql({ board: {}, limit: 5 })).toBe(
      'statusCategory != Done ORDER BY created ASC',
    )
  })

  it('pushes the exclusion list into the query, dropping malformed keys', () => {
    const jql = buildJiraIntakeJql({
      board: { jiraProjectKey: 'PROJ' },
      excludeExternalIds: ['PROJ-1', 'PROJ-2', 'not a key") OR (1=1', 'acme/web#3'],
      limit: 5,
    })
    expect(jql).toContain('issuekey NOT IN (PROJ-1, PROJ-2)')
    expect(jql).not.toContain('1=1')
    expect(jql).not.toContain('acme/web')
  })

  it('escapes quotes in user-supplied predicate values', () => {
    const jql = buildJiraIntakeJql({
      board: { jiraProjectKey: 'PROJ' },
      titleFragment: 'say "hi"',
      limit: 5,
    })
    expect(jql).toContain('summary ~ "say \\"hi\\""')
  })
})

describe('buildJiraIntakeJql (bug hunt)', () => {
  it('pushes the unassigned predicate down as JQL assignee IS EMPTY', () => {
    const jql = buildJiraIntakeJql({
      board: { jiraProjectKey: 'PROJ' },
      unassignedOnly: true,
      limit: 5,
    })
    expect(jql).toContain('assignee IS EMPTY')
  })

  it('leaves the recurring intake untouched when the flag is absent', () => {
    expect(buildJiraIntakeJql({ board: { jiraProjectKey: 'PROJ' }, limit: 5 })).not.toContain(
      'assignee',
    )
  })
})

describe('parseJiraBoards', () => {
  it('maps the project-search page onto boards keyed by project KEY', () => {
    // The key is what `buildJiraIntakeJql` puts in `project = …`, so it has to be the board id.
    expect(
      parseJiraBoards({
        values: [{ key: 'PROJ', name: 'Platform' }, { key: 'WEB' }, { name: 'Keyless' }],
      }),
    ).toEqual([
      { id: 'PROJ', name: 'Platform', key: 'PROJ' },
      { id: 'WEB', name: 'WEB', key: 'WEB' },
    ])
  })

  it('survives a response that is not a project page at all', () => {
    expect(parseJiraBoards(null)).toEqual([])
    expect(parseJiraBoards({ values: 'nope' })).toEqual([])
  })
})

describe('parseJiraBugCandidates', () => {
  const base = 'https://acme.atlassian.net/'

  it('maps the candidate field selection, rendering the ADF body as Markdown', () => {
    const candidates = parseJiraBugCandidates(
      {
        issues: [
          {
            key: 'PROJ-1',
            fields: {
              summary: 'Checkout crashes',
              description: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Click pay.' }] }],
              },
              status: { name: 'To Do' },
              issuetype: { name: 'Bug' },
              priority: { name: 'High' },
              labels: ['checkout'],
              created: '2026-01-02T03:04:05.000+0000',
              comment: { total: 7, comments: [{}, {}] },
            },
          },
        ],
      },
      base,
    )
    expect(candidates).toEqual([
      {
        source: 'jira',
        externalId: 'PROJ-1',
        title: 'Checkout crashes',
        url: 'https://acme.atlassian.net/browse/PROJ-1',
        status: 'To Do',
        type: 'Bug',
        priority: 'High',
        labels: ['checkout'],
        description: 'Click pay.',
        createdAt: '2026-01-02T03:04:05.000+0000',
        // Jira's OWN total, not the two comments the field selection happened to return —
        // reporting "2 comments" for a seven-comment argument understates exactly the
        // contested bugs the ranking should notice.
        commentCount: 7,
      },
    ])
  })

  it('falls back to the returned comment array only when Jira reports no total', () => {
    const [candidate] = parseJiraBugCandidates(
      { issues: [{ key: 'PROJ-2', fields: { comment: { comments: [{}, {}, {}] } } }] },
      base,
    )
    expect(candidate?.commentCount).toBe(3)
  })

  it('fills the gaps a sparse issue leaves, and skips a key-less row', () => {
    const candidates = parseJiraBugCandidates(
      { issues: [{ fields: { summary: 'orphan' } }, { key: 'PROJ-3', fields: {} }] },
      base,
    )
    expect(candidates).toEqual([
      {
        source: 'jira',
        externalId: 'PROJ-3',
        title: '(untitled)',
        url: 'https://acme.atlassian.net/browse/PROJ-3',
        status: '',
        type: '',
        priority: null,
        labels: [],
        description: '',
        createdAt: '',
        commentCount: 0,
      },
    ])
  })

  it('truncates a body long enough to dominate the ranking prompt', () => {
    const [candidate] = parseJiraBugCandidates(
      { issues: [{ key: 'PROJ-4', fields: { description: 'x'.repeat(5_000) } }] },
      base,
    )
    expect(candidate?.description).toHaveLength(1_200)
  })
})
