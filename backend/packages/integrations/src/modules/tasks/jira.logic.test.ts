import { describe, expect, it } from 'vitest'
import {
  buildJiraChildrenJql,
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
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inwardIssue: { key: 'P-2' } },
    ]
    expect(mapJiraIssueLinks(links)).toEqual([{ type: 'blockedBy', externalId: 'P-2' }])
  })

  it('maps an outward "blocks" link to blocks', () => {
    const links = [
      { type: { name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'P-3' } },
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

  it('records an unrecognised relation as relates and tolerates junk', () => {
    expect(
      mapJiraIssueLinks([
        { type: { name: 'Relates', inward: 'relates to', outward: 'relates to' }, inwardIssue: { key: 'P-4' } },
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
