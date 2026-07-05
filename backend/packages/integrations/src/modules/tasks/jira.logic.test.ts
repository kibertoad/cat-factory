import { describe, expect, it } from 'vitest'
import {
  buildJiraChildrenJql,
  buildJiraIntakeJql,
  isJiraEpicType,
  mapJiraIssueLinks,
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
