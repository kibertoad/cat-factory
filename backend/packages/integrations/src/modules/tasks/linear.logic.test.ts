import { describe, expect, it } from 'vitest'
import {
  mapLinearIssue,
  mapLinearRelations,
  mapLinearSearchResults,
  parseLinearRef,
} from './linear.logic.js'

describe('parseLinearRef', () => {
  it('accepts a bare identifier and upper-cases it', () => {
    expect(parseLinearRef('eng-123')).toBe('ENG-123')
    expect(parseLinearRef('  ENG-7 ')).toBe('ENG-7')
  })

  it('extracts the identifier from an issue URL', () => {
    expect(parseLinearRef('https://linear.app/acme/issue/ENG-42/some-title')).toBe('ENG-42')
  })

  it('returns null for junk', () => {
    expect(parseLinearRef('not an issue')).toBeNull()
    expect(parseLinearRef('https://linear.app/acme/document/abc')).toBeNull()
  })

  it('rejects an /issue/<key> path on a non-linear host', () => {
    expect(parseLinearRef('https://evil.example.com/acme/issue/ENG-42')).toBeNull()
  })
})

describe('mapLinearRelations', () => {
  it('maps outward blocks, inverse blocks (blockedBy) and others as relates', () => {
    const links = mapLinearRelations({
      relations: {
        nodes: [
          { type: 'blocks', relatedIssue: { identifier: 'ENG-2' } },
          { type: 'related', relatedIssue: { identifier: 'ENG-3' } },
        ],
      },
      inverseRelations: {
        nodes: [{ type: 'blocks', issue: { identifier: 'ENG-1' } }],
      },
    })
    expect(links).toContainEqual({ type: 'blocks', externalId: 'ENG-2' })
    expect(links).toContainEqual({ type: 'blockedBy', externalId: 'ENG-1' })
    expect(links).toContainEqual({ type: 'relates', externalId: 'ENG-3' })
  })

  it('de-dupes repeated relations', () => {
    const links = mapLinearRelations({
      relations: {
        nodes: [
          { type: 'blocks', relatedIssue: { identifier: 'ENG-2' } },
          { type: 'blocks', relatedIssue: { identifier: 'eng-2' } },
        ],
      },
    })
    expect(links).toHaveLength(1)
  })
})

describe('mapLinearIssue', () => {
  it('maps an issue with sub-issues into a structured TaskContent epic', () => {
    const content = mapLinearIssue({
      issue: {
        identifier: 'ENG-10',
        title: 'Auth epic',
        description: 'Do the **auth** work.\n\n\n\nMore.',
        url: 'https://linear.app/acme/issue/ENG-10',
        priorityLabel: 'High',
        state: { name: 'In Progress', type: 'started' },
        assignee: { name: 'Ada' },
        labels: { nodes: [{ name: 'security' }, { name: '' }] },
        parent: { identifier: 'ENG-1' },
        children: { nodes: [{ identifier: 'ENG-11' }, { identifier: 'ENG-12' }] },
        comments: { nodes: [{ user: { name: 'Bob' }, createdAt: '2026-01-01', body: 'hi' }] },
        relations: { nodes: [{ type: 'blocks', relatedIssue: { identifier: 'ENG-9' } }] },
      },
    })
    expect(content.externalId).toBe('ENG-10')
    expect(content.status).toBe('In Progress')
    expect(content.type).toBe('Epic')
    expect(content.isEpic).toBe(true)
    expect(content.assignee).toBe('Ada')
    expect(content.priority).toBe('High')
    expect(content.labels).toEqual(['security'])
    expect(content.description).toBe('Do the **auth** work.\n\nMore.')
    expect(content.comments).toEqual([{ author: 'Bob', createdAt: '2026-01-01', body: 'hi' }])
    expect(content.parentExternalId).toBe('ENG-1')
    expect(content.childExternalIds).toEqual(['ENG-11', 'ENG-12'])
    expect(content.links).toContainEqual({ type: 'blocks', externalId: 'ENG-9' })
  })

  it('treats a childless issue as a plain Issue', () => {
    const content = mapLinearIssue({ issue: { identifier: 'ENG-5', title: 'x' } })
    expect(content.type).toBe('Issue')
    expect(content.isEpic).toBe(false)
  })

  it('throws when no issue came back', () => {
    expect(() => mapLinearIssue({ issue: null })).toThrow()
  })
})

describe('mapLinearSearchResults', () => {
  it('maps hits and drops identifier-less rows', () => {
    const hits = mapLinearSearchResults({
      searchIssues: {
        nodes: [
          { identifier: 'ENG-1', title: 'One', url: 'u1', state: { name: 'Todo' } },
          { title: 'no id' },
        ],
      },
    })
    expect(hits).toEqual([
      {
        source: 'linear',
        externalId: 'ENG-1',
        title: 'One',
        url: 'u1',
        status: 'Todo',
        excerpt: '',
      },
    ])
  })
})
