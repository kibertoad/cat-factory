import { describe, expect, it } from 'vitest'
import { buildJiraSearchJql, parseJiraSearchResults } from './jira.logic.js'

describe('buildJiraSearchJql', () => {
  it('builds a text-search JQL ordered by recency', () => {
    expect(buildJiraSearchJql('login bug')).toBe('text ~ "login bug" ORDER BY updated DESC')
  })

  it('escapes embedded quotes and backslashes', () => {
    expect(buildJiraSearchJql('a "b" \\c')).toContain('text ~ "a \\"b\\" \\\\c"')
  })
})

describe('parseJiraSearchResults', () => {
  it('maps issues to hits with canonical browse URLs', () => {
    const json = {
      issues: [
        { key: 'PROJ-1', fields: { summary: 'Fix it', status: { name: 'In Progress' } } },
        { key: 'PROJ-2', fields: { summary: 'Other' } },
      ],
    }
    expect(parseJiraSearchResults(json, 'https://team.atlassian.net/')).toEqual([
      {
        source: 'jira',
        externalId: 'PROJ-1',
        title: 'Fix it',
        url: 'https://team.atlassian.net/browse/PROJ-1',
        status: 'In Progress',
        excerpt: '',
      },
      {
        source: 'jira',
        externalId: 'PROJ-2',
        title: 'Other',
        url: 'https://team.atlassian.net/browse/PROJ-2',
        status: '',
        excerpt: '',
      },
    ])
  })

  it('skips issues without a key and tolerates a non-object body', () => {
    expect(parseJiraSearchResults({ issues: [{ fields: {} }] }, 'x')).toEqual([])
    expect(parseJiraSearchResults(null, 'x')).toEqual([])
  })
})
